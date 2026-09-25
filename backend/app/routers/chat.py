"""Chat endpoints. One agent node, one conversation, transcript replayed each turn."""

import asyncio
import dataclasses
import json
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from anyio import to_thread
from fastapi import APIRouter, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pydantic_ai import DeferredToolRequests, DeferredToolResults
from pydantic_ai.messages import ModelMessagesTypeAdapter

from app.config import settings
from app.repositories.project_repo import Message
from app.routers.deps import ProjectRepo, ToolRepo, TurnRepos
from app.services import runs
from app.services.turns import prepare_turn
from app.workflows import (
    ResumeInput,
    attach_events,
    cancel_paused,
    cancel_turn,
    close_dangling_calls,
    run_turn,
    start_turn,
)

router = APIRouter(prefix="/chat", tags=["chat"])

_BUSY = HTTPException(
    status_code=status.HTTP_409_CONFLICT, detail="Agent is already running a turn"
)

# A parked run older than this is abandoned rather than resumed.
_PENDING_RUN_MAX_AGE = timedelta(hours=1)

# Bound on waiting for a just-registered turn's row before answering a cancel.
_CANCEL_ROW_WAIT_S = 5.0


class ChatRequest(BaseModel):
    node_id: UUID
    prompt: str = Field(min_length=1, max_length=32_000)
    # Optional idempotency key: a resend with the same token will not duplicate.
    client_token: str | None = Field(default=None, max_length=100)


class ChatMessage(BaseModel):
    id: UUID
    role: str
    content: str
    seq: int
    status: str
    created_at: datetime
    tool_calls: list[dict[str, Any]] = []

    @classmethod
    def of(cls, m: Message) -> "ChatMessage":
        return cls(
            id=UUID(m.id),
            role=m.role,
            content=m.content,
            seq=m.seq,
            status=m.status,
            created_at=m.created_at,
            tool_calls=m.tool_calls,
        )


class ChatResponse(BaseModel):
    node_id: UUID
    conversation_id: UUID
    output: str
    user_message: ChatMessage
    assistant_message: ChatMessage


class PendingCall(BaseModel):
    """One tool call awaiting approval."""

    tool_call_id: str
    tool_name: str
    arguments: dict[str, Any]


class ApprovalRequiredResponse(BaseModel):
    """A turn paused for tool approval. Switch on ``paused``: ChatResponse never sets it."""

    paused: bool = True
    node_id: UUID
    conversation_id: UUID
    pending_calls: list[PendingCall]


def _pending_calls(pending: DeferredToolRequests) -> list[PendingCall]:
    return [
        PendingCall(
            tool_call_id=part.tool_call_id,
            tool_name=part.tool_name,
            arguments=part.args_as_dict(),
        )
        for part in pending.approvals
    ]


def _record_pending_calls(
    tool_repo: ToolRepo,
    pending: DeferredToolRequests,
    *,
    project_id: str,
    conversation_id: str,
    agent_node_id: str,
    owner_by_tool: dict[str, str],
) -> None:
    """Backfill pending_approval rows RecordingToolset did not already write.

    Skips a tool with no ``owner_by_tool`` entry rather than guessing
    tool_node_id: endpoints filter on it, so a wrong row beats no row.
    """
    for part in pending.approvals:
        existing = tool_repo.get_call_by_tool_call_id(conversation_id, part.tool_call_id)
        if existing is not None:
            continue
        tool_node_id = owner_by_tool.get(part.tool_name)
        if tool_node_id is None:
            continue
        tool_repo.record_call(
            project_id=project_id,
            conversation_id=conversation_id,
            agent_node_id=agent_node_id,
            tool_node_id=tool_node_id,
            tool_call_id=part.tool_call_id,
            tool_name=part.tool_name,
            arguments=part.args_as_dict(),
            status="pending_approval",
        )


async def _park_pending_run(tool_repo: ToolRepo, conversation_id: str, messages: list) -> None:
    payload = ModelMessagesTypeAdapter.dump_json(messages).decode()
    await to_thread.run_sync(lambda: tool_repo.set_pending_run(conversation_id, payload))


def _make_on_paused(
    tool_repo: ToolRepo,
    *,
    project_id: str,
    conversation_id: str,
    agent_node_id: str,
    owner_by_tool: dict[str, str],
):
    """on_paused closure shared by chat, chat_stream and chat_resume.

    run_turn/start_turn call this inside the task, so pending calls are
    recorded and the run parked before the caller ever sees ``turn.pending``.
    """

    async def on_paused(pending: DeferredToolRequests, all_messages: list) -> None:
        await to_thread.run_sync(
            lambda: _record_pending_calls(
                tool_repo,
                pending,
                project_id=project_id,
                conversation_id=conversation_id,
                agent_node_id=agent_node_id,
                owner_by_tool=owner_by_tool,
            )
        )
        await _park_pending_run(tool_repo, conversation_id, all_messages)

    return on_paused


def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, default=str)}\n\n"


async def _events(run):
    """SSE events for a run: start, then chunk/tool/done/error, or approval_required."""
    async for event, payload in attach_events(run):
        if event == "paused":
            yield _sse(
                "approval_required",
                {
                    "conversation_id": run.conversation_id,
                    "pending_calls": [c.model_dump() for c in _pending_calls(payload["pending"])],
                    "assistant_message": payload["assistant_message"],
                },
            )
            return
        yield _sse(event, payload)


_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


@router.post("", response_model=None)
async def chat(
    req: ChatRequest, repo: ProjectRepo, turn_repos: TurnRepos
) -> ChatResponse | ApprovalRequiredResponse:
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    trepo, tool_repo = turn_repos.project, turn_repos.tool
    conversation_id = await to_thread.run_sync(
        lambda: trepo.get_or_create_conversation(node.id, node.project_id)
    )
    prepared = await prepare_turn(turn_repos, node, conversation_id)
    on_paused = _make_on_paused(
        tool_repo,
        project_id=node.project_id,
        conversation_id=conversation_id,
        agent_node_id=node.id,
        owner_by_tool=prepared.tools.owner_by_tool,
    )

    try:
        turn = await run_turn(
            trepo,
            conversation_id,
            node.system_prompt,
            node.model,
            req.prompt,
            node_id=node.id,
            project_id=node.project_id,
            tool_repo=tool_repo,
            client_token=req.client_token,
            # Only the LLM call becomes durable; persistence is identical either way.
            durable=bool(settings.dbos_database_url),
            instructions=prepared.instructions,
            toolsets=prepared.toolsets,
            on_paused=on_paused,
        )
    except runs.TurnBusy:
        raise _BUSY from None

    if turn.pending is not None:
        # on_paused already recorded the pending calls and parked the run.
        return ApprovalRequiredResponse(
            node_id=UUID(node.id),
            conversation_id=UUID(conversation_id),
            pending_calls=_pending_calls(turn.pending),
        )

    return ChatResponse(
        node_id=UUID(node.id),
        conversation_id=UUID(turn.conversation_id),
        output=turn.output,
        user_message=ChatMessage.of(turn.user_message),
        assistant_message=ChatMessage.of(turn.assistant_message),
    )


@router.post("/stream")
async def chat_stream(
    req: ChatRequest, repo: ProjectRepo, turn_repos: TurnRepos
) -> StreamingResponse:
    """Stream a turn as SSE.

    Events: ``start``, ``chunk``, ``tool``, ``done``, ``error``, and
    ``approval_required`` when a tool needs approval. That last one ends the
    stream with no ``done``.
    Checkpointed on the same terms as POST /chat: DBOS configured and no tools.

    The turn runs detached: a client disconnect stops the events, not the run.
    Busy raises 409 before any headers are sent, since start_turn fails before
    the StreamingResponse is built.
    """
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    trepo, tool_repo = turn_repos.project, turn_repos.tool
    conversation_id = await to_thread.run_sync(
        lambda: trepo.get_or_create_conversation(node.id, node.project_id)
    )
    prepared = await prepare_turn(turn_repos, node, conversation_id)
    on_paused = _make_on_paused(
        tool_repo,
        project_id=node.project_id,
        conversation_id=conversation_id,
        agent_node_id=node.id,
        owner_by_tool=prepared.tools.owner_by_tool,
    )

    try:
        run = await start_turn(
            trepo,
            conversation_id,
            node.system_prompt,
            node.model,
            req.prompt,
            node_id=node.id,
            project_id=node.project_id,
            tool_repo=tool_repo,
            client_token=req.client_token,
            durable=bool(settings.dbos_database_url),
            instructions=prepared.instructions,
            toolsets=prepared.toolsets,
            on_paused=on_paused,
        )
    except runs.TurnBusy:
        raise _BUSY from None

    return StreamingResponse(_events(run), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.get("/attach")
async def chat_attach(node_id: UUID, repo: ProjectRepo) -> Response:
    """Re-join a running turn's stream.

    Same events as /chat/stream; ``start`` carries the assistant row so far
    instead of the user message. 204 when nothing is running.
    """
    node = await to_thread.run_sync(repo.get_agent_node, str(node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    conversation_id = await to_thread.run_sync(repo.get_conversation_for_node, node.id)
    run = runs.get(conversation_id) if conversation_id else None
    # message is None between register() and the first DB insert: nothing to
    # snapshot yet, so treat it the same as no run.
    if run is None or run.message is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return StreamingResponse(_events(run), media_type="text/event-stream", headers=_SSE_HEADERS)


class CancelRequest(BaseModel):
    node_id: UUID


class CancelResponse(BaseModel):
    node_id: UUID
    conversation_id: UUID
    message_id: UUID


@router.post("/cancel", response_model=CancelResponse, status_code=status.HTTP_202_ACCEPTED)
async def chat_cancel(
    req: CancelRequest, repo: ProjectRepo, turn_repos: TurnRepos
) -> CancelResponse:
    """Stop a running or parked turn. Nothing is deleted; the partial reply stays."""
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    conversation_id = await to_thread.run_sync(repo.get_conversation_for_node, node.id)
    if conversation_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Nothing running")
    run = runs.get(conversation_id)
    if run is not None:
        await cancel_turn(run)
        if run.message is None and run.task is not None:
            # Registered before its assistant row was written. Wait, bounded,
            # for the row so the response can name it.
            with suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(run.task), _CANCEL_ROW_WAIT_S)
    if run is not None and run.message is not None:
        return CancelResponse(
            node_id=UUID(node.id),
            conversation_id=UUID(conversation_id),
            message_id=UUID(run.message.id),
        )
    parked = await cancel_paused(turn_repos.project, turn_repos.tool, conversation_id, node.id)
    if parked is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Nothing running")
    return CancelResponse(
        node_id=UUID(node.id), conversation_id=UUID(conversation_id), message_id=UUID(parked.id)
    )


class ResumeRequest(BaseModel):
    node_id: UUID
    # tool_call_id -> approved
    approvals: dict[str, bool] = Field(min_length=1)


@router.post("/resume")
async def chat_resume(
    req: ResumeRequest, repo: ProjectRepo, turn_repos: TurnRepos
) -> StreamingResponse:
    """Resume a turn that paused for tool approval, streamed as SSE.

    Same events as /chat/stream, so a resume can pause again with
    ``approval_required``. Toolsets are not serialisable, so they are rebuilt
    from the node. 404/409/422 are raised before any headers are sent.
    """
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    trepo, tool_repo = turn_repos.project, turn_repos.tool
    conversation_id = await to_thread.run_sync(trepo.get_conversation_for_node, node.id)
    if conversation_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")

    pending_run = await to_thread.run_sync(tool_repo.get_pending_run, conversation_id)
    if pending_run is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="No pending approval")

    payload, pending_run_at = pending_run
    if datetime.now(UTC) - pending_run_at > _PENDING_RUN_MAX_AGE:
        await to_thread.run_sync(lambda: tool_repo.set_pending_run(conversation_id, None))
        awaiting = await to_thread.run_sync(
            lambda: trepo.latest_message_with_status(conversation_id, "awaiting_approval")
        )
        if awaiting is not None:
            await to_thread.run_sync(
                lambda: trepo.update_message(awaiting.id, status="failed", error="approval expired")
            )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Pending approval expired")

    for tool_call_id in req.approvals:
        existing = await to_thread.run_sync(
            lambda tid=tool_call_id: tool_repo.get_call_by_tool_call_id(conversation_id, tid)
        )
        if existing is None or existing.get("status") != "pending_approval":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"No pending approval for tool_call_id {tool_call_id}",
            )

    history = ModelMessagesTypeAdapter.validate_json(payload)
    deferred_results = DeferredToolResults(approvals=req.approvals)

    awaiting = await to_thread.run_sync(
        lambda: trepo.latest_message_with_status(conversation_id, "awaiting_approval")
    )
    if awaiting is None:
        # Do not clear pending_run here: a resume can land between on_paused's
        # write and the row flip, while a turn is legitimately pausing again.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="No pending approval")

    # In memory only: start_turn seeds run.events from this row, so the denials
    # ride along and every later write, finalise included, preserves them. Not
    # written here: a TurnBusy below would leave them on a row whose calls are
    # still pending_approval, and a later resume would render an approved call
    # as denied.
    denied = {tid for tid, approved in req.approvals.items() if not approved}
    if denied:
        events = close_dangling_calls(awaiting.tool_calls, status="denied", only=denied)
        awaiting = dataclasses.replace(awaiting, tool_calls=events)

    prepared = await prepare_turn(turn_repos, node, conversation_id)
    on_paused = _make_on_paused(
        tool_repo,
        project_id=node.project_id,
        conversation_id=conversation_id,
        agent_node_id=node.id,
        owner_by_tool=prepared.tools.owner_by_tool,
    )

    try:
        run = await start_turn(
            trepo,
            conversation_id,
            node.system_prompt,
            node.model,
            None,
            node_id=node.id,
            project_id=node.project_id,
            tool_repo=tool_repo,
            instructions=prepared.instructions,
            toolsets=prepared.toolsets,
            on_paused=on_paused,
            resume=ResumeInput(history=history, deferred=deferred_results, message=awaiting),
        )
    except runs.TurnBusy:
        raise _BUSY from None

    # Past TurnBusy the denials are final.
    await to_thread.run_sync(
        lambda: _apply_approval_decisions(tool_repo, conversation_id, req.approvals)
    )

    async def clear_parked_run() -> None:
        # Detached like the run, so a reader leaving cannot skip it.
        await run.task
        if run.result is None or run.result.pending is None:
            # A second pause re-parked through on_paused; keep that one.
            await to_thread.run_sync(lambda: tool_repo.set_pending_run(conversation_id, None))

    runs.track_finaliser(asyncio.ensure_future(clear_parked_run()))

    return StreamingResponse(_events(run), media_type="text/event-stream", headers=_SSE_HEADERS)


def _apply_approval_decisions(
    tool_repo: ToolRepo, conversation_id: str, approvals: dict[str, bool]
) -> None:
    """Mark denied rows. Approved ones already moved to ok or error during the run."""
    for tool_call_id, approved in approvals.items():
        if approved:
            continue
        tool_repo.finish_call_by_tool_call_id(conversation_id, tool_call_id, status="denied")
