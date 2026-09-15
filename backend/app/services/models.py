"""The provider's model catalogue.
"""

import time

import httpx

from app.config import settings

_TIMEOUT = 15.0
_TTL_SECONDS = 900

_cache: tuple[float, list[str]] | None = None


class ModelsUnavailable(Exception):
    """The provider's catalogue could not be read."""


def _endpoint_and_headers() -> tuple[str, dict[str, str]]:
    if settings.llm_provider == "ollama":
        base = settings.ollama_base_url.rstrip("/")
        headers = {}
        if settings.ollama_api_key:
            headers["Authorization"] = f"Bearer {settings.ollama_api_key}"
        return f"{base}/models", headers
    return (
        f"https://generativelanguage.googleapis.com/v1beta/models?key={settings.gemini_api_key}",
        {},
    )


def _parse(payload: dict) -> list[str]:
    if settings.llm_provider == "ollama":
        # OpenAI-compatible shape: {"data": [{"id": ...}]}
        return sorted(m["id"] for m in payload.get("data", []) if m.get("id"))
    # Google returns {"models": [{"name": "models/gemini-..."}]}
    return sorted(
        m["name"].removeprefix("models/") for m in payload.get("models", []) if m.get("name")
    )


async def list_models() -> list[str]:
    """Model names the configured provider serves. Cached.

    Raises ModelsUnavailable rather than returning an empty list, so a caller
    can tell "provider unreachable" from "provider serves nothing".
    """
    global _cache
    if _cache is not None and time.monotonic() - _cache[0] < _TTL_SECONDS:
        return _cache[1]

    url, headers = _endpoint_and_headers()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
            response = await http.get(url, headers=headers)
            response.raise_for_status()
            names = _parse(response.json())
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        raise ModelsUnavailable(f"{type(exc).__name__}") from exc

    if not names:
        raise ModelsUnavailable("provider returned no models")
    _cache = (time.monotonic(), names)
    return names


def refresh() -> None:
    """Drop the cache, so the next list_models call re-fetches."""
    global _cache
    _cache = None
