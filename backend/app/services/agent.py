"""Agent construction.

Agents are initialised per catalog entry.

Construction stays lazy: building an agent at import time crashes the whole app,
including ``/health``, when the API key is unset.
"""

from functools import lru_cache

from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.providers.google import GoogleProvider

from app.config import settings
from app.repositories.chat_repo import Message


@lru_cache(maxsize=32)
def get_agent_for(system_prompt: str, model: str) -> Agent[None, str]:
    """Return an agent for one catalog entry.

    Conversation history is passed per call via ``Agent.run(message_history=...)``
    Tools also passed per call via ``Agent.run(toolsets=...)``.
    """
    return Agent(
        GoogleModel(model, provider=GoogleProvider(api_key=settings.gemini_api_key)),
        system_prompt=system_prompt,
    )


def to_model_messages(history: list[Message]) -> list[ModelMessage]:
    """Map stored message rows onto Pydantic AI's history format.

    Rows with ``status='failed'`` are skipped: replaying a turn the model never
    completed just degrades the next answer. ``system`` rows are skipped.
    """
    messages: list[ModelMessage] = []
    for m in history:
        if m.status != "complete":
            continue
        if m.role == "user":
            messages.append(ModelRequest(parts=[UserPromptPart(content=m.content)]))
        elif m.role == "assistant":
            messages.append(ModelResponse(parts=[TextPart(content=m.content)]))
    return messages
