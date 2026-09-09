"""Tool slug to spec.

Mirrors how agent_types.slug resolves through code. A tool_types row whose
slug is absent here is reported as unconfigured rather than crashing a turn.
"""

from app.tools import mcp_servers, skills
from app.tools.api import brave_search
from app.tools.base import ToolSpec

_MCP = ToolSpec(kind="mcp", build=mcp_servers.build, verify=mcp_servers.verify)

# Every MCP service shares one handler. A service row differs only in its
# config_schema: which fields the user fills in, and the default_url the node
# is created with. Adding one means a tool_types row plus a slug listed here.
_MCP_SLUGS = ("mcp_server", "github", "obsidian", "gmail")

_REGISTRY: dict[str, ToolSpec] = {
    "skill": ToolSpec(kind="skill", build=skills.build, verify=skills.verify),
    "brave_search": ToolSpec(kind="api", build=brave_search.build, verify=brave_search.verify),
    **{slug: _MCP for slug in _MCP_SLUGS},
}


def get_spec(slug: str) -> ToolSpec | None:
    return _REGISTRY.get(slug)


def known_slugs() -> list[str]:
    return sorted(_REGISTRY)
