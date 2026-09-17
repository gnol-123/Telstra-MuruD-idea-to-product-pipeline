"""Chat endpoints. One agent node, one conversation, transcript replayed each turn."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from anyio import to_thread
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pydantic_ai import DeferredToolRequests, DeferredToolResults
from pydantic_ai.messages import ModelMessagesTypeAdapter

from app.config import settings
from app.repositories.project_repo import Message
from app.routers.deps import ProjectRepo, ToolRepo, TurnRepos
from app.services.turns import prepare_turn
from app.workflows import resume_agent, run_turn, stream_turn

router = APIRouter(prefix="/chat", tags=["chat"])

# A parked run older than this is abandoned rather than resumed.
_PENDING_RUN_MAX_AGE = timedelta(hours=1)


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

    @classmethod
    def of(cls, m: Message) -> "ChatMessage":
        return cls(
            id=UUID(m.id),
            role=m.role,
            content=m.content,
            seq=m.seq,
            status=m.status,
            created_at=m.created_at,
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


class ResumeResponse(BaseModel):
    """A completed resume. No ``user_message``: the prompt was persisted on the paused turn."""

    node_id: UUID
    conversation_id: UUID
    output: str
    assistant_message: ChatMessage


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

    turn = await run_turn(
        trepo,
        conversation_id,
        node.system_prompt,
        node.model,
        req.prompt,
        client_token=req.client_token,
        # Only the LLM call becomes durable; persistence is identical either way.
        durable=bool(settings.dbos_database_url),
        instructions=prepared.instructions,
        toolsets=prepared.toolsets,
    )

    if turn.pending is not None:
        await to_thread.run_sync(
            lambda: _record_pending_calls(
                tool_repo,
                turn.pending,
                project_id=node.project_id,
                conversation_id=conversation_id,
                agent_node_id=node.id,
                owner_by_tool=prepared.tools.owner_by_tool,
            )
        )
        await _park_pending_run(tool_repo, conversation_id, turn.all_messages)
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
    """
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    trepo, tool_repo = turn_repos.project, turn_repos.tool
    conversation_id = await to_thread.run_sync(
        lambda: trepo.get_or_create_conversation(node.id, node.project_id)
    )
    prepared = await prepare_turn(turn_repos, node, conversation_id)

    async def on_paused(pending: DeferredToolRequests, all_messages: list) -> None:
        await to_thread.run_sync(
            lambda: _record_pending_calls(
                tool_repo,
                pending,
                project_id=node.project_id,
                conversation_id=conversation_id,
                agent_node_id=node.id,
                owner_by_tool=prepared.tools.owner_by_tool,
            )
        )
        await _park_pending_run(tool_repo, conversation_id, all_messages)

    async def events():
        async for event, payload in stream_turn(
            trepo,
            conversation_id,
            node.system_prompt,
            node.model,
            req.prompt,
            client_token=req.client_token,
            durable=bool(settings.dbos_database_url),
            instructions=prepared.instructions,
            toolsets=prepared.toolsets,
            on_paused=on_paused,
        ):
            if event == "paused":
                approval_payload = {
                    "conversation_id": conversation_id,
                    "pending_calls": [c.model_dump() for c in _pending_calls(payload["pending"])],
                }
                yield f"event: approval_required\ndata: {json.dumps(approval_payload)}\n\n"
                # No done event: the turn has not produced a reply.
                return
            yield f"event: {event}\ndata: {json.dumps(payload, default=str)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Stops nginx-style proxies buffering the stream into one response.
            "X-Accel-Buffering": "no",
        },
    )


class ResumeRequest(BaseModel):
    node_id: UUID
    # tool_call_id -> approved
    approvals: dict[str, bool] = Field(min_length=1)


@router.post("/resume", response_model=None)
async def chat_resume(
    req: ResumeRequest, repo: ProjectRepo, turn_repos: TurnRepos
) -> ResumeResponse | ApprovalRequiredResponse:
    """Resume a turn that paused for tool approval.

    Toolsets are not serialisable, so they are rebuilt from the node. A resume
    can pause again; same branch handles it.
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

    prepared = await prepare_turn(turn_repos, node, conversation_id)

    try:
        turn = await resume_agent(
            node.system_prompt,
            node.model,
            history,
            deferred_results,
            prepared.toolsets,
        )
    except Exception as exc:
        await to_thread.run_sync(lambda: tool_repo.set_pending_run(conversation_id, None))
        turn_error = str(exc)
        assistant_message = await to_thread.run_sync(
            lambda: trepo.add_message(
                conversation_id, "assistant", "", status="failed", error=turn_error
            )
        )
        return ResumeResponse(
            node_id=UUID(node.id),
            conversation_id=UUID(conversation_id),
            output="",
            assistant_message=ChatMessage.of(assistant_message),
        )

    # Decisions are settled: denied were answered without a result, approved ran.
    await to_thread.run_sync(
        lambda: _apply_approval_decisions(tool_repo, conversation_id, req.approvals)
    )

    if turn.pending is not None:
        # Second pause. Same path as the first; pending_run is overwritten, not cleared.
        await to_thread.run_sync(
            lambda: _record_pending_calls(
                tool_repo,
                turn.pending,
                project_id=node.project_id,
                conversation_id=conversation_id,
                agent_node_id=node.id,
                owner_by_tool=prepared.tools.owner_by_tool,
            )
        )
        await _park_pending_run(tool_repo, conversation_id, turn.all_messages)
        return ApprovalRequiredResponse(
            node_id=UUID(node.id),
            conversation_id=UUID(conversation_id),
            pending_calls=_pending_calls(turn.pending),
        )

    await to_thread.run_sync(lambda: tool_repo.set_pending_run(conversation_id, None))

    assistant_message = await to_thread.run_sync(
        lambda: trepo.add_message(
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

    return ResumeResponse(
        node_id=UUID(node.id),
        conversation_id=UUID(conversation_id),
        output=turn.output,
        assistant_message=ChatMessage.of(assistant_message),
    )


def _apply_approval_decisions(
    tool_repo: ToolRepo, conversation_id: str, approvals: dict[str, bool]
) -> None:
    """Mark denied rows. Approved ones already moved to ok or error during the run."""
    for tool_call_id, approved in approvals.items():
        if approved:
            continue
        tool_repo.finish_call_by_tool_call_id(conversation_id, tool_call_id, status="denied")
