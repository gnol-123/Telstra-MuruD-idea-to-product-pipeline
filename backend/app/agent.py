from functools import lru_cache

from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.providers.anthropic import AnthropicProvider

from app.config import settings


@lru_cache
def get_agent() -> Agent[None, str]:
    model = AnthropicModel(
        settings.anthropic_model,
        provider=AnthropicProvider(api_key=settings.anthropic_api_key),
    )
    return Agent(model, system_prompt="You are a helpful assistant.")
