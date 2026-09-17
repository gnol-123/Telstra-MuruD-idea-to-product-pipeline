"""Turn orchestration, with the LLM call optionally checkpointed by DBOS.

Only the pure LLM call goes inside a DBOS step. Persistence stays outside it:
DBOS serialises step arguments to Postgres, so a Supabase client cannot be
pickled and a JWT would be a credential written to disk.

``run_agent_step`` writes nothing. The user row lands before it and the
assistant row after, so its retries cannot produce duplicate rows.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

import anyio
from dbos import DBOS
from pydantic_ai import DeferredToolRequests, DeferredToolResults
from pydantic_ai.messages import ModelMessage
from pydantic_ai.usage import UsageLimits

from app.config import settings
from app.repositories.project_repo import Edge, InboundContext, Message, ProjectRepository
from app.services.agent import get_agent_for, summarise_conversation, to_model_messages

log = logging.getLogger(__name__)


@dataclass
class AgentTurn:
    """The result of one agent call, before it is saved."""

    output: str
    model: str
    input_tokens: int | None = None
    # Includes reasoning, on every provider. See _reasoning_from.
    output_tokens: int | None = None
    reasoning_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    # Model requests behind this turn: >1 when tool calls loop.
    requests: int | None = None
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
    error: str | None = None
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


def _limits() -> UsageLimits:
    """Per-turn cap on model requests. UsageLimitExceeded lands as a failed row."""
    return UsageLimits(request_limit=settings.turn_request_limit)


async def refresh_edge(repo: ProjectRepository, edge: Edge) -> Edge | None:
    """Regenerate one context edge's summary from its source conversation."""
    from anyio import to_thread

    conversation_id = await to_thread.run_sync(repo.get_conversation_for_node, edge.source_node_id)
    if conversation_id is None:
        # Nothing to summarise; record it so the edge stops reading as stale.
        return await to_thread.run_sync(lambda: repo.update_edge_summary(edge.id, "", 0))

    # Read before summarising, so a message landing mid-call re-stales the edge.
    head = await to_thread.run_sync(repo.get_conversation_head, edge.source_node_id)
    history = await to_thread.run_sync(repo.list_messages, conversation_id)
    summary = await summarise_conversation(history, max_words=edge.summary_max_words)
    return await to_thread.run_sync(lambda: repo.update_edge_summary(edge.id, summary, head))


async def refresh_outbound(repo: ProjectRepository, node_id: str) -> list[str]:
    """Refresh every context edge leaving a node. Returns the ids that failed.

    One summariser call per distinct summary_max_words: three edges out of one
    scoping agent are the same transcript three times.
    """
    from anyio import to_thread

    edges = await to_thread.run_sync(repo.list_outbound_context_edges, node_id)
    if not edges:
        return []

    conversation_id = await to_thread.run_sync(repo.get_conversation_for_node, node_id)
    head = await to_thread.run_sync(repo.get_conversation_head, node_id)
    history = (
        await to_thread.run_sync(repo.list_messages, conversation_id) if conversation_id else []
    )

    failed: list[str] = []
    by_words: dict[int, list[Edge]] = {}
    for e in edges:
        by_words.setdefault(e.summary_max_words, []).append(e)

    for max_words, group in by_words.items():
        try:
            summary = await summarise_conversation(history, max_words=max_words) if history else ""
        except Exception:
            log.exception("summary failed for %s (%d words)", node_id, max_words)
            failed.extend(e.id for e in group)
            continue
        for e in group:
            try:
                await to_thread.run_sync(
                    lambda e=e, summary=summary: repo.update_edge_summary(e.id, summary, head)
                )
            except Exception:
                log.exception("summary store failed for edge %s", e.id)
                failed.append(e.id)
    return failed


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
        usage_limits=_limits(),
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
        usage_limits=_limits(),
    )
    return _turn_from_result(result, model)


def _reasoning_from(usage: object) -> int | None:
    """Reasoning tokens, wherever the provider put them.

    pydantic-ai has no typed field for this: each model adapter lifts it into
    ``usage.details`` under its own name (OpenAI/Ollama ``reasoning_tokens``,
    Anthropic ``thinking_tokens``, Google ``thoughts_tokens``). Always a subset
    of ``output_tokens``, never additive, so never sum the two.
    """
    details = getattr(usage, "details", None) or {}
    for key in ("reasoning_tokens", "thinking_tokens", "thoughts_tokens"):
        value = details.get(key)
        if isinstance(value, int):
            return value
    return None


def _turn_from(output: str, model: str, usage: object) -> AgentTurn:
    return AgentTurn(
        output=output,
        model=model,
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        reasoning_tokens=_reasoning_from(usage),
        cache_read_tokens=getattr(usage, "cache_read_tokens", None),
        cache_write_tokens=getattr(usage, "cache_write_tokens", None),
        requests=getattr(usage, "requests", None),
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
            cache_read_tokens=turn.cache_read_tokens,
            cache_write_tokens=turn.cache_write_tokens,
            requests=turn.requests,
            status="failed" if turn.failed else "complete",
            error=turn.error,
        )
    )

    return ChatTurn(
        conversation_id=conversation_id,
        user_message=user_message,
        assistant_message=assistant_message,
        output=turn.output,
        error=turn.error,
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
    from pydantic_ai.messages import (
        FunctionToolCallEvent,
        FunctionToolResultEvent,
        PartDeltaEvent,
        PartStartEvent,
        TextPart,
        TextPartDelta,
    )

    send, receive = anyio.create_memory_object_stream[tuple[str, dict]](64)

    async def handler(ctx, stream) -> None:
        async for event in stream:
            if isinstance(event, FunctionToolCallEvent):
                await send.send(
                    ("tool", {"name": event.part.tool_name, "args": event.part.args_as_dict()})
                )
                continue
            if isinstance(event, FunctionToolResultEvent):
                await send.send(
                    (
                        "tool",
                        {
                            "name": getattr(event.part, "tool_name", None),
                            "result_head": str(getattr(event.part, "content", ""))[:200],
                        },
                    )
                )
                continue
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
        usage_limits=_limits(),
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
        # A pause still burned tokens. Carry the usage so the approval path can
        # bill it; only `output` is unsafe to persist here.
        turn = _turn_from("", model, result.usage)
        turn.pending = result.output
        turn.all_messages = result.all_messages()
        return turn
    return _turn_from(result.output, model, result.usage)


# Strong refs to detached turns: asyncio only holds weak ones, and a task
# nobody awaits could otherwise be collected mid-run.
_DETACHED: set[asyncio.Task] = set()


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
    on_paused: Callable[[DeferredToolRequests, list[ModelMessage]], Awaitable[None]] | None = None,
) -> AsyncIterator[tuple[str, dict]]:
    """Stream one turn, yielding ``(event, payload)`` pairs.

    Events: ``start``, ``chunk``, ``tool``, ``done``, ``error``, ``paused``.

    Detached: the model run and its persistence live in a task that outlives
    this generator. A reader that leaves (closed tab, proxy timeout) stops
    receiving; it does not stop the turn. ``on_paused`` runs inside the task
    for the same reason: the approval bookkeeping must not depend on a reader.

    ``paused`` replaces ``done`` when the run stops for tool approval; no
    assistant message is persisted then. Same write order as ``run_turn``.
    """
    from anyio import to_thread

    history = await to_thread.run_sync(repo.list_messages, conversation_id)
    user_message = await to_thread.run_sync(
        lambda: repo.add_message(conversation_id, "user", prompt, client_token=client_token)
    )
    yield (
        "start",
        {"conversation_id": conversation_id, "user_message": _message_payload(user_message)},
    )

    send, receive = anyio.create_memory_object_stream[tuple[str, dict]](64)

    async def emit(item: tuple[str, dict]) -> None:
        try:
            # Blocks when the buffer is full: backpressure on a slow reader,
            # never a dropped event. A reader that left closes the stream.
            await send.send(item)
        except (anyio.BrokenResourceError, anyio.ClosedResourceError):
            # Reader left. Keep running; the rows still land.
            pass

    async def drive() -> None:
        chunks: list[str] = []
        turn: AgentTurn | None = None
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
                if event in ("chunk", "tool"):
                    if event == "chunk":
                        chunks.append(payload["text"])
                    await emit((event, payload))
                elif event == "paused":
                    if on_paused is not None:
                        try:
                            await on_paused(payload["pending"], payload["all_messages"])
                        except Exception:
                            # The pause is unresumable now, but no assistant row
                            # belongs here either. Log and end the turn.
                            log.exception("on_paused failed for turn %s", conversation_id)
                    await emit((event, payload))
                    return
                else:
                    turn = payload["turn"]
        except Exception as exc:
            turn = AgentTurn(output="".join(chunks), model=model, error=str(exc))
            await emit(("error", {"error": str(exc)}))

        if turn is None:
            return
        assistant_message = await to_thread.run_sync(
            lambda: repo.add_message(
                conversation_id,
                "assistant",
                turn.output,
                model=turn.model,
                input_tokens=turn.input_tokens,
                output_tokens=turn.output_tokens,
                reasoning_tokens=turn.reasoning_tokens,
                cache_read_tokens=turn.cache_read_tokens,
                cache_write_tokens=turn.cache_write_tokens,
                requests=turn.requests,
                status="failed" if turn.failed else "complete",
                error=turn.error,
            )
        )
        await emit(("done", {"assistant_message": _message_payload(assistant_message)}))

    async def run() -> None:
        try:
            await drive()
        except Exception:
            # Nobody may be awaiting this task; log rather than lose it.
            log.exception("detached turn %s failed", conversation_id)
        finally:
            send.close()

    task = asyncio.ensure_future(run())
    _DETACHED.add(task)
    task.add_done_callback(_DETACHED.discard)
    try:
        async with receive:
            async for item in receive:
                yield item
    finally:
        if not task.done():
            log.info("client left; turn %s continues detached", conversation_id)


async def join_detached(timeout: float) -> int:
    """Wait for detached turns at shutdown. Returns how many are still running."""
    pending = [t for t in _DETACHED if not t.done()]
    if not pending:
        return 0
    await asyncio.wait(pending, timeout=timeout)
    still_running = sum(1 for t in pending if not t.done())
    if still_running:
        log.warning("%d detached turn(s) still running at shutdown", still_running)
    return still_running


def _message_payload(m: Message) -> dict:
    return {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "seq": m.seq,
        "status": m.status,
        "created_at": m.created_at,
    }
