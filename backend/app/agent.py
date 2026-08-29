from functools import lru_cache

from pydantic_ai import Agent
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.providers.google import GoogleProvider

from app.config import settings


@lru_cache
def get_agent() -> Agent[None, str]:
    model = GoogleModel(
        settings.gemini_model,
        provider=GoogleProvider(api_key=settings.gemini_api_key),
    )
    return Agent(model, system_prompt="You are a helpful assistant.")
