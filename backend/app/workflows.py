"""Durable workflows.

Using DBOS workflows to wrap the agent call in a checkpointed, retryable step.
DBOS checkpoints each '@DBOS.step' decorated function, so if the process is
interrupted, it can resume from the last successful step.

1. ``run_agent_step`` performs the LLM call and *writes nothing*. The user row
   is written before it and the assistant row after it, so its three retry
   attempts cannot produce three rows.

2. Only the pure LLM call is checkpointed. Persistence stays in ``run_turn``,
   outside the DBOS boundary, because DBOS serializes step arguments and
   results -- a Supabase client holds a thread lock and cannot be pickled.
   Keeping the token out of DBOS is also deliberate: checkpointed arguments are
   written to Postgres, and a JWT is a live credential.
"""

from dataclasses import dataclass

from dbos import DBOS

from app.repositories.chat_repo import ChatRepository, Message
from app.services.agent import get_agent_for, to_model_messages


@dataclass
class AgentTurn:
    """The result of one agent call, before it is saved."""

    output: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
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


async def call_agent(system_prompt: str, model: str, prompt: str, history: list) -> AgentTurn:
    """Run one agent trun, doesn't save to DB"""
    agent = get_agent_for(system_prompt, model)
    result = await agent.run(prompt, message_history=to_model_messages(history))
    usage = result.usage
    return AgentTurn(
        output=result.output,
        model=model,
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
    )


@DBOS.step(retries_allowed=True, max_attempts=3)
async def run_agent_step(system_prompt: str, model: str, prompt: str, history: list) -> AgentTurn:
    """Call the agent and checkpoint the result to DBOS, so a crash mid-call
    resumes from the checkpoint instead of paying for the model twice.
    """
    return await call_agent(system_prompt, model, prompt, history)


async def run_turn(
    repo: ChatRepository,
    conversation_id: str,
    system_prompt: str,
    model: str,
    prompt: str,
    *,
    client_token: str | None = None,
    durable: bool = False,
) -> ChatTurn:
    """Persist the user turn, call the agent, persist the reply.

    Shared by both paths in ``routers.chat`` so that running without DBOS
    behaves identically to running with it. ``durable`` only decides whether
    the LLM call is checkpointed, so a crash mid-call resumes from the
    checkpoint instead of paying for the model twice.
    """
    from anyio import to_thread

    history = await to_thread.run_sync(repo.list_messages, conversation_id)

    user_message = await to_thread.run_sync(
        lambda: repo.add_message(conversation_id, "user", prompt, client_token=client_token)
    )

    # A turn that fails is recorded on the transcript rather than raised: the
    # user's own message is already stored, and an orphaned user row with no
    # reply is worse than a visible failure. Identical on both paths.
    try:
        if durable:
            turn = await run_agent_step(system_prompt, model, prompt, history)
        else:
            turn = await call_agent(system_prompt, model, prompt, history)
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
