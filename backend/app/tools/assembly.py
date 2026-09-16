"""
Turn configured tool nodes into toolsets for one agent run.
"""

import re
import time
from dataclasses import dataclass, field
from typing import Any

from anyio import to_thread
from pydantic_ai import ApprovalRequired, ModelRetry, RunContext
from pydantic_ai.toolsets import (
    AbstractToolset,
    ApprovalRequiredToolset,
    PrefixedToolset,
    WrapperToolset,
)
from pydantic_ai.toolsets.abstract import ToolsetTool

from app.repositories.tool_repo import ToolNode, load_node_secrets
from app.tools.base import ToolContext
from app.tools.oauth_refresh import with_access_token
from app.tools.registry import get_spec, platform_secrets

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
    owner_by_tool: dict[str, str] = field(default_factory=dict)
    unavailable: list[str] = field(default_factory=list)
    # Same order and length as ``toolsets``: the node id each entry came
    # from, so a caller can wrap each toolset for recording without
    # re-deriving ownership from tool names.
    owner_by_toolset: list[str] = field(default_factory=list)
    # Instruction text describing a group of toolsets to the model. Kept
    # separate from unavailable so a caller composes them in one place.
    notes: list[str] = field(default_factory=list)


@dataclass
class RecordingToolset(WrapperToolset):
    """Writes a tool_calls row around every invocation.

    One instance per tool node, built where the conversation id is known
    (the chat router), never inside a DBOS-checkpointed step.
    """

    repo: Any = None
    project_id: str = ""
    conversation_id: str = ""
    agent_node_id: str = ""
    tool_node_id: str = ""

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext, tool: ToolsetTool
    ) -> Any:
        started = time.perf_counter()
        call_id = await to_thread.run_sync(
            lambda: self.repo.record_call(
                project_id=self.project_id,
                conversation_id=self.conversation_id,
                agent_node_id=self.agent_node_id,
                tool_node_id=self.tool_node_id,
                tool_call_id=ctx.tool_call_id,
                tool_name=name,
                arguments=tool_args,
                status="running",
            )
        )
        try:
            result = await super().call_tool(name, tool_args, ctx, tool)
        except ModelRetry:
            # The tool asked for a retry itself. Record and let it through.
            await to_thread.run_sync(lambda: self.repo.finish_call(call_id, status="error"))
            raise
        except ApprovalRequired:
            # Control flow, not a failure: the run pauses for user approval.
            # Task 10 handles the pause; the row stays pending_approval.
            await to_thread.run_sync(
                lambda: self.repo.finish_call(call_id, status="pending_approval")
            )
            raise
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            await to_thread.run_sync(
                lambda: self.repo.finish_call(
                    call_id,
                    status="error",
                    error=message,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                )
            )
            # Hand the failure to the model rather than killing the turn.
            raise ModelRetry(f"{name} failed: {exc}") from exc

        await to_thread.run_sync(
            lambda: self.repo.finish_call(
                call_id,
                status="ok",
                result=str(result)[:8000],
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        )
        return result


async def assemble(repo, tool_nodes: list[ToolNode], *, ask: bool) -> AssembledTools:
    toolsets: list[AbstractToolset] = []
    owner_by_tool: dict[str, str] = {}
    owner_by_toolset: list[str] = []
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
            keys = await to_thread.run_sync(
                lambda n=node: repo.secret_keys(n.id) if repo is not None else []
            )
            secrets = (
                await to_thread.run_sync(lambda n=node, k=keys: load_node_secrets(n.id, k))
                if keys
                else {}
            )
            # Platform keys fill gaps; a user's own key wins.
            secrets = {**platform_secrets(node.tool_slug), **secrets}
            # oauth2 nodes need a live access token before build, which is sync.
            secrets = await with_access_token(node.tool_slug, node.id, secrets)
            built = spec.build(
                ToolContext(
                    node_id=node.id,
                    name=node.name,
                    config=node.config,
                    secrets=secrets,
                )
            )
        except Exception:
            unavailable.append(node.name)
            continue

        if spec.kind == "mcp":
            # Prefix per node for each service_tool in MCP server.
            # and record the whole prefix as the owner key.
            prefix = _prefix(node)
            owner_by_tool[prefix] = node.id
            toolsets.append(PrefixedToolset(built, prefix))
        else:
            # Skill and API tools already embed a node-id suffix in their own
            # tool name, so the name straight off the toolset is unique.
            for tool_name in getattr(built, "tools", {}):
                owner_by_tool[tool_name] = node.id
            toolsets.append(built)
        owner_by_toolset.append(node.id)

    if ask and toolsets:
        toolsets = [ApprovalRequiredToolset(t) for t in toolsets]

    return AssembledTools(
        toolsets=toolsets,
        owner_by_tool=owner_by_tool,
        unavailable=unavailable,
        owner_by_toolset=owner_by_toolset,
    )


def record_calls(
    tools: AssembledTools,
    *,
    repo,
    project_id: str,
    conversation_id: str,
    agent_node_id: str,
) -> list[AbstractToolset]:
    """Wrap each assembled toolset so every call it serves writes a row.

    Built where the conversation id is known (the chat router), never inside
    a DBOS-checkpointed step: ``repo`` and any secrets a toolset holds must
    stay out of a workflow argument.
    """
    return [
        RecordingToolset(
            toolset,
            repo=repo,
            project_id=project_id,
            conversation_id=conversation_id,
            agent_node_id=agent_node_id,
            tool_node_id=node_id,
        )
        for toolset, node_id in zip(tools.toolsets, tools.owner_by_toolset, strict=True)
    ]


def unavailable_note(names: list[str]) -> str | None:
    """Tell the model a capability exists but is not usable this turn."""
    if not names:
        return None
    listed = ", ".join(names)
    return (
        f"These connected tools are unavailable right now and cannot be called: {listed}. "
        "Say so if the user asks for something that needs them."
    )
