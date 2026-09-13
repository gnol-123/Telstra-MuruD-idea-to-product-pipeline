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
from pydantic_ai import DeferredToolRequests, DeferredToolResults
from pydantic_ai.messages import ModelMessage

from app.repositories.project_repo import InboundContext, Message, ProjectRepository
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
    # Set when the run paused for approval. Output is empty; do not persist it.
    pending: DeferredToolRequests | None = None
    # History at the pause, for parking and resuming. None on a normal turn.
    all_messages: list[ModelMessage] | None = None

    @property
    def failed(self) -> bool:
        return self.error is not None

    @property
    def paused(self) -> bool:
        return self.pending is not None


@dataclass
class ChatTurn:
    """Result of user prompt and LLM reply.

    ``assistant_message`` is None when the turn paused for approval: no
    reply was produced, so nothing was persisted for it.
    """

    conversation_id: str
    user_message: Message
    assistant_message: Message | None
    output: str
    pending: DeferredToolRequests | None = None
    all_messages: list[ModelMessage] | None = None


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
    return _turn_from_result(result, model)


async def resume_agent(
    system_prompt: str,
    model: str,
    message_history: list[ModelMessage],
    deferred_tool_results: DeferredToolResults,
    toolsets: list | None = None,
) -> AgentTurn:
    """Resume a run that paused for tool approval. Writes nothing.

    No ``user_prompt``: this continues the parked run rather than starting a
    new one. A resumed run may pause again, e.g. a second approval-required
    tool; that shows up the same way as the first pause, via ``AgentTurn.pending``.
    """
    agent = get_agent_for(system_prompt, model)
    result = await agent.run(
        message_history=message_history,
        deferred_tool_results=deferred_tool_results,
        toolsets=toolsets or None,
    )
    return _turn_from_result(result, model)


def _turn_from(output: str, model: str, usage: object) -> AgentTurn:
    return AgentTurn(
        output=output,
        model=model,
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        reasoning_tokens=getattr(usage, "output_reasoning_tokens", None),
    )


@DBOS.workflow(name="chat.run_agent")
async def run_agent_step(
    system_prompt: str,
    model: str,
    prompt: str,
    history: list,
    instructions: str | None = None,
) -> AgentTurn:
    """Checkpointed LLM call, so a crash mid-call does not pay for it twice.

    A workflow, not a step: ``DBOSDurability`` on the agent turns the model
    request itself into a step, and that only happens inside a workflow.

    No ``toolsets`` parameter by design. Toolsets hold live credentials and are
    built per turn, so they cannot be registered with DBOS when the agent is
    constructed, which is what durable tool calls require. A turn that has
    already fired side-effecting calls is not safely replayable either. Tool
    turns take the direct path instead.
    """
    return await call_agent(system_prompt, model, prompt, history, instructions)


async def run_turn(
    repo: ProjectRepository,
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
    # Failures go on the transcript, not raised: an orphan user row is worse.
    try:
        if use_durable:
            turn = await run_agent_step(system_prompt, model, prompt, history, instructions)
        else:
            turn = await call_agent(system_prompt, model, prompt, history, instructions, toolsets)
    except Exception as exc:
        turn = AgentTurn(output="", model=model, error=str(exc))

    if turn.paused:
        # Paused, no reply. The router parks the history and records the calls.
        return ChatTurn(
            conversation_id=conversation_id,
            user_message=user_message,
            assistant_message=None,
            output="",
            pending=turn.pending,
            all_messages=turn.all_messages,
        )

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


async def _stream_agent(
    system_prompt: str,
    model: str,
    prompt: str,
    history: list,
    *,
    instructions: str | None = None,
    toolsets: list | None = None,
    durable: bool = False,
) -> AsyncIterator[tuple[str, dict]]:
    """Run one agent turn, yielding ``chunk`` deltas then one ``done`` or ``paused``.

    ``agent.run()`` with an ``event_stream_handler``, not ``run_stream``: the
    latter raises inside a DBOS workflow. The handler runs concurrently with the
    run, so deltas cross to this generator through a memory stream.

    Tools force the direct path, same rule as ``run_turn``.
    """
    import asyncio

    import anyio
    from pydantic_ai.messages import PartDeltaEvent, PartStartEvent, TextPart, TextPartDelta

    send, receive = anyio.create_memory_object_stream[tuple[str, dict]](64)

    async def handler(ctx, stream) -> None:
        async for event in stream:
            text = None
            if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                text = event.part.content
            elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                text = event.delta.content_delta
            if text:
                await send.send(("chunk", {"text": text}))

    use_durable = durable and not toolsets
    runner = _run_agent_durable if use_durable else _run_agent_direct

    async def drive() -> AgentTurn:
        # The stream closes on any exit, so a failed run cannot hang the reader.
        try:
            return await runner(
                system_prompt, model, prompt, history, instructions, toolsets, handler
            )
        finally:
            send.close()

    # A bare task, not a task group: a cancel scope cannot span the ``yield``
    # below, because an async generator may be resumed or closed from a
    # different task than the one that entered it.
    task = asyncio.ensure_future(drive())
    try:
        async with receive:
            async for item in receive:
                yield item
    finally:
        if task.done():
            # Surface the run's own failure, not whatever the reader saw.
            result = task.result()
            if result.paused:
                yield "paused", {"pending": result.pending, "all_messages": result.all_messages}
            else:
                yield "done", {"turn": result}
        else:
            # Reader left early; nothing will await the task.
            task.cancel()


async def _run_agent_direct(
    system_prompt, model, prompt, history, instructions, toolsets, handler
) -> AgentTurn:
    agent = get_agent_for(system_prompt, model)
    result = await agent.run(
        prompt,
        message_history=to_model_messages(history),
        instructions=instructions,
        toolsets=toolsets or None,
        event_stream_handler=handler,
    )
    return _turn_from_result(result, model)


@DBOS.workflow(name="chat.stream_agent")
async def _run_agent_durable(
    system_prompt, model, prompt, history, instructions, toolsets, handler
) -> AgentTurn:
    """Checkpointed counterpart to ``_run_agent_direct``.

    ``handler`` is a live closure, so it never crosses a step boundary: DBOS
    serialises workflow arguments, but ``DBOSDurability`` reads the handler off
    the run and invokes it inside the model-request step.
    """
    return await _run_agent_direct(
        system_prompt, model, prompt, history, instructions, toolsets, handler
    )


def _turn_from_result(result, model: str) -> AgentTurn:
    if isinstance(result.output, DeferredToolRequests):
        return AgentTurn(
            output="",
            model=model,
            pending=result.output,
            all_messages=result.all_messages(),
        )
    return _turn_from(result.output, model, result.usage)


async def stream_turn(
    repo: ProjectRepository,
    conversation_id: str,
    system_prompt: str,
    model: str,
    prompt: str,
    *,
    client_token: str | None = None,
    durable: bool = False,
    instructions: str | None = None,
    toolsets: list | None = None,
) -> AsyncIterator[tuple[str, dict]]:
    """Stream one turn, yielding ``(event, payload)`` pairs.

    Events: ``start``, ``chunk``, ``done``, ``error``, ``paused``.

    ``paused`` replaces ``done`` when the run stops for tool approval instead
    of answering: the payload carries ``pending`` (the ``DeferredToolRequests``)
    and ``all_messages`` (the history to park), and no assistant message is
    persisted. The chat router turns this into the ``approval_required`` SSE
    event and the pending-run bookkeeping; nothing here talks to ``tool_repo``.

    Same write order as ``run_turn``, user row first and assistant row last, so
    idempotency and seq ordering match. The assembled text is persisted once the
    stream drains.

    Durable when DBOS is configured and the turn has no tools, on the same terms
    as ``run_turn``: ``_stream_agent`` is a workflow whose model request becomes
    a checkpointed step. Text reaches the caller through an
    ``event_stream_handler`` rather than ``run_stream``, which pydantic-ai
    rejects inside a workflow.
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
        async for event, payload in _stream_agent(
            system_prompt,
            model,
            prompt,
            history,
            instructions=instructions,
            toolsets=toolsets,
            durable=durable,
        ):
            if event == "chunk":
                chunks.append(payload["text"])
                yield event, payload
            elif event == "paused":
                yield event, payload
                return
            else:
                turn = payload["turn"]
    except Exception as exc:
        # Headers are sent, so no 4xx. Emit an event and record the failure.
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
