"""Agent construction.

Agents are initialised per catalog entry.

Construction stays lazy: building an agent at import time crashes the whole app,
including ``/health``, when the API key is unset.
"""

from functools import lru_cache
from hashlib import sha256

from pydantic_ai import Agent, DeferredToolRequests
from pydantic_ai.durable_exec.dbos import DBOSDurability
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models import Model
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.ollama import OllamaProvider

from app.config import settings
from app.repositories.project_repo import Message


def _model(name: str) -> Model:
    """Build a model for one name, for user defined model name defaulted to: deepseek v4.1 flash
    """
    if settings.llm_provider == "ollama":
        return OllamaModel(
            name,
            provider=OllamaProvider(
                base_url=settings.ollama_base_url, api_key=settings.ollama_api_key
            ),
        )
    return GoogleModel(name, provider=GoogleProvider(api_key=settings.gemini_api_key))

@lru_cache(maxsize=256)
def get_agent_for(system_prompt: str, model: str) -> Agent[None, str | DeferredToolRequests]:
    """Return an agent for one catalog entry.

    Conversation history is passed per call via ``Agent.run(message_history=...)``
    Tools also passed per call via ``Agent.run(toolsets=...)``.

    ``output_type`` includes ``DeferredToolRequests`` so a run pauses for tool
    approval instead of raising: without it, a deferred tool call makes
    pydantic-ai raise UserError rather than returning it as output. This is a
    constant added to every agent, so it does not change the cache key.

    ``DBOSDurability`` routes model requests through DBOS steps when the run is
    inside a workflow, and is transparent otherwise, so the same agent serves
    installs with and without DBOS configured. ``name`` identifies its steps and
    must be stable across restarts or a recovering workflow cannot find them.
    """
    return Agent(
        _model(model),
        system_prompt=system_prompt,
        output_type=[str, DeferredToolRequests],
        name=_agent_name(system_prompt, model),
        capabilities=[DBOSDurability()],
    )


def _agent_name(system_prompt: str, model: str) -> str:
    """Stable DBOS step-name prefix for one catalog entry.

    Hashed, not the raw prompt: step names land in Postgres and the prompt is
    unbounded text. Same inputs as the cache key, so one agent means one name.
    """
    digest = sha256(f"{model}\0{system_prompt}".encode()).hexdigest()[:16]
    return f"agent_{digest}"


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


# Fallback when a caller has no edge to read the limit from. The
# edges.summary_max_words column carries the real per-edge value.
DEFAULT_SUMMARY_MAX_WORDS = 200

_SUMMARY_PROMPT = (
    "You summarise one agent's conversation so a different agent can pick up "
    "the thread. Report the facts, decisions and constraints that were "
    "established, not the fact that a conversation happened. Write plain "
    "statements: 'The target market is SMB fintech', never 'They discussed the "
    "target market'. Omit pleasantries, meta-commentary and anything the user "
    "did not actually settle. If nothing of substance was decided, say so in "
    "one line. Keep it under {max_words} words."
)


@lru_cache(maxsize=8)
def _summary_agent(max_words: int) -> Agent[None, str]:
    return Agent(
        _model(settings.summary_model),
        system_prompt=_SUMMARY_PROMPT.format(max_words=max_words),
    )


def _transcript(history: list[Message]) -> str:
    """Flatten a transcript for summarising."""
    lines = []
    for m in history:
        if m.status != "complete" or m.role not in ("user", "assistant"):
            continue
        lines.append(f"{m.role}: {m.content}")
    return "\n\n".join(lines)


async def summarise_conversation(
    history: list[Message], max_words: int = DEFAULT_SUMMARY_MAX_WORDS
) -> str:
    """Condense a conversation into context for a downstream agent.

    ``max_words`` comes from the edge, so a feeder with a long history can
    be given more room than a brief one.

    Returns an empty string for an empty transcript, without calling the
    model, so a freshly created node costs nothing to summarise.
    """
    transcript = _transcript(history)
    if not transcript.strip():
        return ""

    result = await _summary_agent(max_words).run(
        f"Summarise this conversation in at most {max_words} words:\n\n{transcript}"
    )
    return result.output.strip()
