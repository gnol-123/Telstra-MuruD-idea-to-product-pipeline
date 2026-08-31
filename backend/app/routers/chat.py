from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings
from app.services.agent import get_agent

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    prompt: str


class ChatResponse(BaseModel):
    output: str


@router.post("", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    # With DBOS configured the turn runs as a durable workflow; without it we
    # call the agent directly so the API still works with no database.
    if settings.dbos_database_url:
        from app.workflows import chat_workflow

        return ChatResponse(output=await chat_workflow(req.prompt))

    result = await get_agent().run(req.prompt)
    return ChatResponse(output=result.output)
