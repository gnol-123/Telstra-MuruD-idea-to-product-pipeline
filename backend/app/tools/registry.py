"""Tool slug to spec.

Mirrors how agent_types.slug resolves through code. A tool_types row whose
slug is absent here is reported as unconfigured rather than crashing a turn.
"""

from app.tools import mcp_servers, skills
from app.tools.api import brave_search
from app.tools.base import ToolSpec

_MCP = ToolSpec(kind="mcp", build=mcp_servers.build, verify=mcp_servers.verify)

# MCP Slug list is hardcoded here,
# because the MCP toolset is not a single tool,
# but a collection of tools that are dynamically loaded from the MCP server.
# The slugs are used to identify which tools are part of the MCP toolset.

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
