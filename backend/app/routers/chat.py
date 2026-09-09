"""Chat endpoint.

A turn is addressed to one agent node. The node owns a single conversation,
whose transcript is persisted and replayed into the model on the next turn.
"""

import json
from datetime import datetime
from uuid import UUID

from anyio import to_thread
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.repositories.chat_repo import Message
from app.routers.deps import ChatRepo, ToolRepo
from app.tools.assembly import AssembledTools, assemble, record_calls, unavailable_note
from app.workflows import build_context_instructions, run_turn, stream_turn

router = APIRouter(prefix="/chat", tags=["chat"])


async def _inbound_instructions(repo: ChatRepo, node_id: str) -> str | None:
    """Context from agents whose arrows point at this node.

    Stale summaries are included; refreshing is the user's call.
    """
    context = await to_thread.run_sync(repo.list_inbound_context, node_id)
    return build_context_instructions(context)


async def _inbound_toolsets(repo: ChatRepo, tool_repo: ToolRepo, node) -> AssembledTools:
    """Toolsets from tool nodes whose arrows point at this agent."""
    node_ids = await to_thread.run_sync(repo.list_inbound_tool_node_ids, node.id)
    if not node_ids:
        return AssembledTools()
    nodes = [
        n
        for n in (await to_thread.run_sync(lambda: [tool_repo.get_tool_node(i) for i in node_ids]))
        if n is not None
    ]
    return assemble(tool_repo, nodes, ask=node.tool_policy == "ask")


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


@router.post("", response_model=ChatResponse)
async def chat(req: ChatRequest, repo: ChatRepo, tool_repo: ToolRepo) -> ChatResponse:
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))

    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    conversation_id = await to_thread.run_sync(
        lambda: repo.get_or_create_conversation(node.id, node.project_id)
    )

    instructions = await _inbound_instructions(repo, node.id)

    tools = await _inbound_toolsets(repo, tool_repo, node)
    note = unavailable_note(tools.unavailable)
    if note:
        instructions = "\n\n".join(p for p in [instructions, note] if p)
    toolsets = record_calls(
        tools,
        repo=tool_repo,
        project_id=node.project_id,
        conversation_id=conversation_id,
        agent_node_id=node.id,
    )

    turn = await run_turn(
        repo,
        conversation_id,
        node.system_prompt,
        node.model,
        req.prompt,
        client_token=req.client_token,
        # Only the LLM call becomes durable; persistence is identical either way.
        durable=bool(settings.dbos_database_url),
        instructions=instructions,
        toolsets=toolsets,
    )

    return ChatResponse(
        node_id=UUID(node.id),
        conversation_id=UUID(turn.conversation_id),
        output=turn.output,
        user_message=ChatMessage.of(turn.user_message),
        assistant_message=ChatMessage.of(turn.assistant_message),
    )


@router.post("/stream")
async def chat_stream(req: ChatRequest, repo: ChatRepo, tool_repo: ToolRepo) -> StreamingResponse:
    """Stream a turn as server-sent events.

    Events: ``start`` (conversation id + the persisted user message),
    ``chunk`` (a piece of text), ``done`` (the persisted assistant message),
    and ``error`` if the model fails part-way.

    DBOS does not checkpoint the stream, but it does the assembled text once the stream ends.
    """
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    conversation_id = await to_thread.run_sync(
        lambda: repo.get_or_create_conversation(node.id, node.project_id)
    )

    instructions = await _inbound_instructions(repo, node.id)

    tools = await _inbound_toolsets(repo, tool_repo, node)
    note = unavailable_note(tools.unavailable)
    if note:
        instructions = "\n\n".join(p for p in [instructions, note] if p)
    toolsets = record_calls(
        tools,
        repo=tool_repo,
        project_id=node.project_id,
        conversation_id=conversation_id,
        agent_node_id=node.id,
    )

    async def events():
        async for event, payload in stream_turn(
            repo,
            conversation_id,
            node.system_prompt,
            node.model,
            req.prompt,
            client_token=req.client_token,
            instructions=instructions,
            toolsets=toolsets,
        ):
            yield (f"event: {event}\ndata: {json.dumps(payload)}\n\n")

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Stops nginx-style proxies buffering the stream into one response.
            "X-Accel-Buffering": "no",
        },
    )
