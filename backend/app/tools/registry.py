"""Tool slug to spec.

Mirrors how agent_types.slug resolves through code. A tool_types row whose
slug is absent here is reported as unconfigured rather than crashing a turn.
"""

from app.tools import skills
from app.tools.api import brave_search
from app.tools.base import ToolSpec
from app.tools.mcp import generic, github, gmail

_REGISTRY: dict[str, ToolSpec] = {
    "skill": ToolSpec(kind="skill", build=skills.build, verify=skills.verify),
    "brave_search": ToolSpec(kind="api", build=brave_search.build, verify=brave_search.verify),
    "mcp_server": ToolSpec(kind="mcp", build=generic.build, verify=generic.verify),
    "github": ToolSpec(kind="mcp", build=github.build, verify=github.verify),
    "gmail": ToolSpec(kind="mcp", build=gmail.build, verify=gmail.verify),
}


def get_spec(slug: str) -> ToolSpec | None:
    return _REGISTRY.get(slug)


def known_slugs() -> list[str]:
    return sorted(_REGISTRY)
