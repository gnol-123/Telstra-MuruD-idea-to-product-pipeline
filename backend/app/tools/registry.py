"""Tool slug to spec.

Mirrors how agent_types.slug resolves through code. A tool_types row whose
slug is absent here is reported as unconfigured rather than crashing a turn.
"""

from app.config import settings
from app.tools import skills
from app.tools.api import brave_search, web_fetch
from app.tools.base import ToolSpec
from app.tools.mcp import generic, github, gmail

_REGISTRY: dict[str, ToolSpec] = {
    "skill": ToolSpec(kind="skill", build=skills.build, verify=skills.verify),
    "brave_search": ToolSpec(kind="api", build=brave_search.build, verify=brave_search.verify),
    "web_fetch": ToolSpec(kind="api", build=web_fetch.build, verify=web_fetch.verify),
    "mcp_server": ToolSpec(kind="mcp", build=generic.build, verify=generic.verify),
    "github": ToolSpec(kind="mcp", build=github.build, verify=github.verify),
    "gmail": ToolSpec(kind="mcp", build=gmail.build, verify=gmail.verify),
    "context7": ToolSpec(kind="mcp", build=generic.build, verify=generic.verify),
}

# Operator-supplied keys, keyed as each handler reads them from ctx.secrets.
# A slug absent here has no platform key.
_PLATFORM_KEYS: dict[str, dict[str, str]] = {
    "brave_search": {"api_key": "brave_api_key"},
    "context7": {"auth_token": "context7_api_key"},
}


def get_spec(slug: str) -> ToolSpec | None:
    return _REGISTRY.get(slug)


def known_slugs() -> list[str]:
    return sorted(_REGISTRY)


def platform_secrets(slug: str) -> dict[str, str]:
    """Operator-supplied keys for a tool, keyed as the handler expects them."""
    out: dict[str, str] = {}
    for secret_key, setting_name in _PLATFORM_KEYS.get(slug, {}).items():
        value = getattr(settings, setting_name, "")
        if value:
            out[secret_key] = value
    return out
