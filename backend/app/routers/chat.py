from fastapi import APIRouter
from pydantic import BaseModel

from app.agent import get_agent

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    prompt: str


class ChatResponse(BaseModel):
    output: str


@router.post("", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    result = await get_agent().run(req.prompt)
    return ChatResponse(output=result.output)
