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
from app.routers.deps import ChatRepo
from app.workflows import run_turn, stream_turn

router = APIRouter(prefix="/chat", tags=["chat"])


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
async def chat(req: ChatRequest, repo: ChatRepo) -> ChatResponse:
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))

    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    conversation_id = await to_thread.run_sync(
        lambda: repo.get_or_create_conversation(node.id, node.project_id)
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
    )

    return ChatResponse(
        node_id=UUID(node.id),
        conversation_id=UUID(turn.conversation_id),
        output=turn.output,
        user_message=ChatMessage.of(turn.user_message),
        assistant_message=ChatMessage.of(turn.assistant_message),
    )


@router.post("/stream")
async def chat_stream(req: ChatRequest, repo: ChatRepo) -> StreamingResponse:
    """Stream a turn as server-sent events.

    Events: ``start`` (conversation id + the persisted user message),
    ``chunk`` (a piece of text), ``done`` (the persisted assistant message),
    and ``error`` if the model fails part-way.

    The turn is persisted exactly as ``POST /chat`` persists it. Only the LLM
    call differs: the reply is streamed, then the assembled text is written.
    Unlike ``/chat`` this is not DBOS-checkpointed, because a step checkpoints
    a return value and a stream has none.
    """
    node = await to_thread.run_sync(repo.get_agent_node, str(req.node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    conversation_id = await to_thread.run_sync(
        lambda: repo.get_or_create_conversation(node.id, node.project_id)
    )

    async def events():
        async for event, payload in stream_turn(
            repo,
            conversation_id,
            node.system_prompt,
            node.model,
            req.prompt,
            client_token=req.client_token,
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
