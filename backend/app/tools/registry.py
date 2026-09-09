"""Tool slug to spec.

Mirrors how agent_types.slug resolves through code. A tool_types row whose
slug is absent here is reported as unconfigured rather than crashing a turn.
"""

from app.tools import mcp_servers, skills
from app.tools.api import brave_search
from app.tools.base import ToolSpec

_REGISTRY: dict[str, ToolSpec] = {
    "skill": ToolSpec(kind="skill", build=skills.build, verify=skills.verify),
    "brave_search": ToolSpec(kind="api", build=brave_search.build, verify=brave_search.verify),
    "mcp_server": ToolSpec(kind="mcp", build=mcp_servers.build, verify=mcp_servers.verify),
}


def get_spec(slug: str) -> ToolSpec | None:
    return _REGISTRY.get(slug)


def known_slugs() -> list[str]:
    return sorted(_REGISTRY)
