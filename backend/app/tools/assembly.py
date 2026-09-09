"""Turn configured tool nodes into toolsets for one agent run.

Building a toolset must never raise into a turn. A node that cannot be built
is dropped and named, exactly like an unready one.
"""

import re
from dataclasses import dataclass, field

from pydantic_ai.toolsets import AbstractToolset, ApprovalRequiredToolset, PrefixedToolset

from app.repositories.tool_repo import ToolNode, load_node_secrets
from app.tools.base import ToolContext
from app.tools.registry import get_spec

_PREFIX_SAFE = re.compile(r"[^a-z0-9_]+")


def _prefix(node: ToolNode) -> str:
    """MCP tool names come from the remote server, so a node prefix keeps two
    MCP boxes from colliding.
    """
    stem = _PREFIX_SAFE.sub("_", node.name.strip().lower()).strip("_")
    return f"{stem or 'tool'}_{node.id[:8]}"


@dataclass(frozen=True)
class AssembledTools:
    toolsets: list[AbstractToolset] = field(default_factory=list)
    # Tool name to owning node id, across all three flavours. MCP tool names
    # are looked up by prefix since PrefixedToolset renames at call time; skill
    # and API tool names are read straight off the built toolset since those
    # already carry a node-id suffix of their own.
    owner_by_tool: dict[str, str] = field(default_factory=dict)
    unavailable: list[str] = field(default_factory=list)


def assemble(repo, tool_nodes: list[ToolNode], *, ask: bool) -> AssembledTools:
    toolsets: list[AbstractToolset] = []
    owner_by_tool: dict[str, str] = {}
    unavailable: list[str] = []

    for node in tool_nodes:
        if node.status != "ready":
            unavailable.append(node.name)
            continue

        spec = get_spec(node.tool_slug)
        if spec is None:
            unavailable.append(node.name)
            continue

        try:
            keys = repo.secret_keys(node.id) if repo is not None else []
            secrets = load_node_secrets(node.id, keys) if keys else {}
            built = spec.build(
                ToolContext(
                    node_id=node.id,
                    name=node.name,
                    config=node.config,
                    secrets=secrets,
                )
            )
        except Exception:  # noqa: BLE001 - one broken node must not fail the turn
            unavailable.append(node.name)
            continue

        if spec.kind == "mcp":
            # Remote tool names are outside our control, so prefix per node
            # and record the whole prefix as the owner key. Task 9 can strip
            # the prefix pydantic-ai applies to recover this same key.
            prefix = _prefix(node)
            owner_by_tool[prefix] = node.id
            toolsets.append(PrefixedToolset(built, prefix))
        else:
            # Skill and API tools already embed a node-id suffix in their own
            # tool name, so the name straight off the toolset is unique.
            for tool_name in getattr(built, "tools", {}):
                owner_by_tool[tool_name] = node.id
            toolsets.append(built)

    if ask and toolsets:
        toolsets = [ApprovalRequiredToolset(t) for t in toolsets]

    return AssembledTools(toolsets=toolsets, owner_by_tool=owner_by_tool, unavailable=unavailable)


def unavailable_note(names: list[str]) -> str | None:
    """Tell the model a capability exists but is not usable this turn."""
    if not names:
        return None
    listed = ", ".join(names)
    return (
        f"These connected tools are unavailable right now and cannot be called: {listed}. "
        "Say so if the user asks for something that needs them."
    )
