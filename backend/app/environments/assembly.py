"""Environment nodes to toolsets for one agent turn.

Wrapper is decided per environment from its own tool_policy, where a tool
node's is decided once from the agent's. Stopping a shell command in someone's
repository and stopping one in a scratch space are different risks.
"""

import re

from anyio import to_thread
from pydantic_ai.toolsets import ApprovalRequiredToolset, PrefixedToolset

from app.environments.base import WORKSPACE_ROOT, EnvContext
from app.environments.lifecycle import ensure_provisioned
from app.environments.registry import get_spec
from app.repositories.environment_repo import EnvNode
from app.tools.assembly import AssembledTools

# The four tools every environment exposes. Named here so the approval
# backfill can register their prefixed forms without building a toolset.
ENV_TOOL_NAMES = ("run_command", "read_file", "write_file", "list_files")

_SAFE = re.compile(r"[^a-z0-9_]+")

# Function name cap
_MAX_STEM = 30


def env_prefix(name: str, node_id: str) -> str:
    """A per node prefix, so two environments cannot collide on tool names."""
    stem = _SAFE.sub("_", name.strip().lower()).strip("_")[:_MAX_STEM].rstrip("_")
    return f"{stem or 'env'}_{node_id[:8]}"


def _status_writer(env_repo, node_id: str):
    """Lets a tool mark its node errored without holding a repository."""

    async def write(status: str, detail: str | None) -> None:
        await to_thread.run_sync(lambda: env_repo.set_status(node_id, status, detail))

    return write


async def assemble_environments(
    env_repo, nodes: list[EnvNode], *, agent_node_id: str
) -> AssembledTools:
    """Build one prefixed toolset per reachable environment.

    Never raises: an environment that cannot be built lands in ``unavailable``
    and the model is told, exactly as a broken tool node is.
    """
    toolsets: list = []
    owner_by_tool: dict[str, str] = {}
    owner_by_toolset: list[str] = []
    unavailable: list[str] = []
    described: list[tuple[EnvNode, str]] = []

    for node in nodes:
        current = node
        if current.status == "pending":
            # First use of a scratch space pays for the sandbox here. Slower
            # than provisioning in the background, but the agent's first
            # attempt works instead of always failing.
            current = await ensure_provisioned(env_repo, current)

        # error is included on purpose: the tools self-heal on a successful
        # connect, so an environment that recovered gets used this turn.
        if current.status not in ("ready", "error") or not current.sandbox_id:
            unavailable.append(current.name)
            continue

        spec = get_spec(current.runtime)
        if spec is None:
            unavailable.append(current.name)
            continue

        ctx = EnvContext(
            node_id=current.id,
            project_id=current.project_id,
            name=current.name,
            config=current.config,
            status=current.status,
            agent_node_id=agent_node_id,
            set_status=_status_writer(env_repo, current.id),
        )
        try:
            built = spec.build(ctx)
        except Exception:
            unavailable.append(current.name)
            continue

        prefix = env_prefix(current.name, current.id)
        toolset = PrefixedToolset(built, prefix)
        if current.tool_policy == "ask":
            toolset = ApprovalRequiredToolset(toolset)

        owner_by_tool[prefix] = current.id
        # pydantic-ai reports the prefixed name, and _record_pending_calls
        # looks the owner up by exactly that.
        for base in ENV_TOOL_NAMES:
            owner_by_tool[f"{prefix}_{base}"] = current.id

        toolsets.append(toolset)
        owner_by_toolset.append(current.id)
        described.append((current, prefix))

    note = environment_note(described, agent_node_id)
    return AssembledTools(
        toolsets=toolsets,
        owner_by_tool=owner_by_tool,
        unavailable=unavailable,
        owner_by_toolset=owner_by_toolset,
        notes=[note] if note else [],
    )


def merge_assembled(a: AssembledTools, b: AssembledTools) -> AssembledTools:
    """Combine two assemblies into one turn's toolsets.

    toolsets and owner_by_toolset stay parallel: record_calls zips them with
    strict=True, so a length mismatch would break every turn.
    """
    return AssembledTools(
        toolsets=[*a.toolsets, *b.toolsets],
        owner_by_tool={**a.owner_by_tool, **b.owner_by_tool},
        unavailable=[*a.unavailable, *b.unavailable],
        owner_by_toolset=[*a.owner_by_toolset, *b.owner_by_toolset],
        notes=[*a.notes, *b.notes],
    )


def environment_note(described: list[tuple[EnvNode, str]], agent_node_id: str) -> str | None:
    """Tell the model which environments it has and what each is for."""
    if not described:
        return None

    lines = [
        "You can execute code in these environments. Each exposes run_command, "
        "read_file, write_file and list_files under the prefix shown. Relative "
        f"paths resolve against your own directory, {WORKSPACE_ROOT}/{agent_node_id}. "
        f"Other agents' directories under {WORKSPACE_ROOT} are readable."
    ]
    for node, prefix in described:
        purpose = node.config.get("description") or (
            "the project's shared scratch space"
            if node.role == "scratch"
            else "an environment the user provisioned"
        )
        lines.append(f'- "{node.name}" (tools: {prefix}_*): {purpose}.')
    return "\n".join(lines)
