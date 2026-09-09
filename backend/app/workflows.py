"""Turn orchestration, with the LLM call optionally checkpointed by DBOS.

Only the pure LLM call goes inside a DBOS step. Persistence stays outside it:
DBOS serialises step arguments to Postgres, so a Supabase client cannot be
pickled and a JWT would be a credential written to disk.

``run_agent_step`` writes nothing. The user row lands before it and the
assistant row after, so its retries cannot produce duplicate rows.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass

from dbos import DBOS

from app.repositories.chat_repo import ChatRepository, InboundContext, Message
from app.services.agent import get_agent_for, to_model_messages


@dataclass
class AgentTurn:
    """The result of one agent call, before it is saved."""

    output: str
    model: str
    input_tokens: int | None = None
    # Gemini counts reasoning here.
    output_tokens: int | None = None
    reasoning_tokens: int | None = None
    error: str | None = None

    @property
    def failed(self) -> bool:
        return self.error is not None


@dataclass
class ChatTurn:
    """Result of user prompt and LLM reply."""

    conversation_id: str
    user_message: Message
    assistant_message: Message
    output: str


def build_context_instructions(context: list[InboundContext]) -> str | None:
    """Format inbound edge summaries as per-call instructions.

    Kept out of the system prompt: that is the ``get_agent_for`` cache key.
    """
    if not context:
        return None
    parts = ["Context from other agents in this project:"]
    for c in context:
        parts.append(f"\n## {c.source_node_name}\n{c.summary}")
    return "\n".join(parts)


async def call_agent(
    system_prompt: str,
    model: str,
    prompt: str,
    history: list,
    instructions: str | None = None,
    toolsets: list | None = None,
) -> AgentTurn:
    """Run one agent turn. Writes nothing."""
    agent = get_agent_for(system_prompt, model)
    result = await agent.run(
        prompt,
        message_history=to_model_messages(history),
        instructions=instructions,
        toolsets=toolsets or None,
    )
    return _turn_from(result.output, model, result.usage)


def _turn_from(output: str, model: str, usage: object) -> AgentTurn:
    return AgentTurn(
        output=output,
        model=model,
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        reasoning_tokens=getattr(usage, "output_reasoning_tokens", None),
    )


@DBOS.step(retries_allowed=True, max_attempts=5)
async def run_agent_step(
    system_prompt: str,
    model: str,
    prompt: str,
    history: list,
    instructions: str | None = None,
) -> AgentTurn:
    """Checkpointed LLM call, so a crash mid-call does not pay for it twice.

    No ``toolsets`` parameter by design. A toolset holds live credentials that
    must not be checkpointed, and a turn that has already fired side-effecting
    calls is not safely replayable. Tool turns take the direct path instead.
    """
    return await call_agent(system_prompt, model, prompt, history, instructions)


async def run_turn(
    repo: ChatRepository,
    conversation_id: str,
    system_prompt: str,
    model: str,
    prompt: str,
    *,
    client_token: str | None = None,
    durable: bool = False,
    instructions: str | None = None,
    toolsets: list | None = None,
) -> ChatTurn:
    """Persist the user turn, call the agent, persist the reply.

    Shared by both paths in ``routers.chat``, so behaviour with and without
    DBOS is identical apart from the checkpoint. Tools force the direct path
    regardless of ``durable``: see ``run_agent_step``.
    """
    from anyio import to_thread

    history = await to_thread.run_sync(repo.list_messages, conversation_id)

    user_message = await to_thread.run_sync(
        lambda: repo.add_message(conversation_id, "user", prompt, client_token=client_token)
    )

    use_durable = durable and not toolsets
    # Failures are recorded on the transcript, not raised: the user row is
    # already stored, and an orphan is worse than a visible failure.
    try:
        if use_durable:
            turn = await run_agent_step(system_prompt, model, prompt, history, instructions)
        else:
            turn = await call_agent(system_prompt, model, prompt, history, instructions, toolsets)
    except Exception as exc:
        turn = AgentTurn(output="", model=model, error=str(exc))

    assistant_message = await to_thread.run_sync(
        lambda: repo.add_message(
            conversation_id,
            "assistant",
            turn.output,
            model=turn.model,
            input_tokens=turn.input_tokens,
            output_tokens=turn.output_tokens,
            reasoning_tokens=turn.reasoning_tokens,
            status="failed" if turn.failed else "complete",
            error=turn.error,
        )
    )

    return ChatTurn(
        conversation_id=conversation_id,
        user_message=user_message,
        assistant_message=assistant_message,
        output=turn.output,
    )


async def stream_turn(
    repo: ChatRepository,
    conversation_id: str,
    system_prompt: str,
    model: str,
    prompt: str,
    *,
    client_token: str | None = None,
    instructions: str | None = None,
    toolsets: list | None = None,
) -> AsyncIterator[tuple[str, dict]]:
    """Stream one turn, yielding ``(event, payload)`` pairs.

    Events: ``start``, ``chunk``, ``done``, ``error``.

    Same write order as ``run_turn``, user row first and assistant row last, so
    idempotency and seq ordering match. Never checkpointed: DBOS records a
    step's return value and a generator has none. The assembled text is
    persisted once the stream drains.
    """
    from anyio import to_thread

    history = await to_thread.run_sync(repo.list_messages, conversation_id)
    user_message = await to_thread.run_sync(
        lambda: repo.add_message(conversation_id, "user", prompt, client_token=client_token)
    )
    yield (
        "start",
        {
            "conversation_id": conversation_id,
            "user_message": _message_payload(user_message),
        },
    )

    chunks: list[str] = []
    turn: AgentTurn
    try:
        agent = get_agent_for(system_prompt, model)
        async with agent.run_stream(
            prompt,
            message_history=to_model_messages(history),
            instructions=instructions,
            toolsets=toolsets or None,
        ) as result:
            async for text in result.stream_text(delta=True):
                chunks.append(text)
                yield "chunk", {"text": text}
            # Only valid once the stream has drained.
            turn = _turn_from("".join(chunks), model, result.usage)
    except Exception as exc:
        # Headers are already sent, so this cannot be a 4xx. Emit an event and
        # still record the failure on the transcript.
        turn = AgentTurn(output="".join(chunks), model=model, error=str(exc))
        yield "error", {"error": str(exc)}

    assistant_message = await to_thread.run_sync(
        lambda: repo.add_message(
            conversation_id,
            "assistant",
            turn.output,
            model=turn.model,
            input_tokens=turn.input_tokens,
            output_tokens=turn.output_tokens,
            reasoning_tokens=turn.reasoning_tokens,
            status="failed" if turn.failed else "complete",
            error=turn.error,
        )
    )
    yield "done", {"assistant_message": _message_payload(assistant_message)}


def _message_payload(m: Message) -> dict:
    return {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "seq": m.seq,
        "status": m.status,
        "created_at": m.created_at,
    }
