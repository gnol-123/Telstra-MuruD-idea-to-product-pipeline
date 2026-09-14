"""Projects and the agent nodes provisioned inside them."""

import logging
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from anyio import to_thread
from fastapi import APIRouter, HTTPException, Query, status
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field

from app.environments import lifecycle
from app.repositories.project_repo import (
    AgentType,
    DuplicateEdge,
    DuplicateProjectName,
    Edge,
    Node,
    Project,
)
from app.repositories.tool_repo import ToolNode, ToolPreset, ToolType, load_node_secrets
from app.routers.deps import EnvRepo, ProjectRepo, ToolRepo
from app.routers.environments import EnvironmentNodeResponse, create_environment_node
from app.services.agent import summarise_conversation
from app.tools.base import ToolContext
from app.tools.oauth_refresh import TokenExchangeError, with_access_token
from app.tools.registry import get_spec, platform_secrets

router = APIRouter(tags=["projects"])

log = logging.getLogger(__name__)

# Where default tool boxes land relative to their agent. Overlap is the
# frontend's problem.
_DEFAULT_TOOL_DX = -260
_DEFAULT_TOOL_DY = 90


# -- PROJECTS ------------------------------------------------------------------


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class ProjectResponse(BaseModel):
    id: UUID
    name: str

    @classmethod
    def of(cls, p: Project) -> "ProjectResponse":
        return cls(id=UUID(p.id), name=p.name)


@router.post("/projects", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    req: CreateProjectRequest, repo: ProjectRepo, env_repo: EnvRepo
) -> ProjectResponse:
    try:
        project = await to_thread.run_sync(lambda: repo.create_project(req.name, req.description))
    except DuplicateProjectName as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You already have a project named '{req.name}'",
        ) from exc

    # Every project owns a scratch space. Not provisioned yet: pending costs nothing.
    await to_thread.run_sync(lambda: env_repo.ensure_scratch_node(project.id))
    return ProjectResponse.of(project)


@router.get("/projects", response_model=list[ProjectResponse])
async def list_projects(repo: ProjectRepo) -> list[ProjectResponse]:
    projects = await to_thread.run_sync(repo.list_projects)
    return [ProjectResponse.of(p) for p in projects]


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: UUID, repo: ProjectRepo, env_repo: EnvRepo) -> None:
    """Delete a project, cascading to its nodes, edges, conversations and messages."""
    # Every environment on the canvas, before the rows cascade away and the
    # sandbox ids go with them.
    environments = await to_thread.run_sync(env_repo.list_environment_nodes, str(project_id))
    for env in environments:
        await lifecycle.teardown(env_repo, env)

    deleted = await to_thread.run_sync(repo.delete_project, str(project_id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")


# -- AGENT NODES ---------------------------------------------------------------


class AgentTypeResponse(BaseModel):
    id: UUID
    slug: str
    name: str
    default_presets: list[str] = []

    @classmethod
    def of(cls, a: AgentType) -> "AgentTypeResponse":
        return cls(id=UUID(a.id), slug=a.slug, name=a.name, default_presets=a.default_presets)


class CreateNodeRequest(BaseModel):
    kind: Literal["agent", "tool", "environment"] = "agent"
    # The catalog slug, so the frontend need not resolve UUIDs to provision.
    # Required for kind='agent'.
    agent_slug: str | None = Field(default=None, min_length=1, max_length=50)
    # Required for kind='tool'.
    tool_slug: str | None = Field(default=None, min_length=1, max_length=50)
    # kind='tool' alternative to tool_slug: instantiate a library preset.
    preset_slug: str | None = Field(default=None, min_length=1, max_length=50)
    # kind='tool' only. Non-secret keys go to nodes.config, secret keys to the vault.
    config: dict[str, Any] = Field(default_factory=dict)
    # Defaults to the template's name if omitted.
    name: str | None = Field(default=None, min_length=1, max_length=200)
    position_x: float = 0
    position_y: float = 0


class UpdateNodeRequest(BaseModel):
    """Partial update. Only the fields sent are changed. node_type and owner_id are fixed."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    position_x: float | None = None
    position_y: float | None = None
    tool_policy: Literal["ask", "auto"] | None = None


class NodeResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    agent_slug: str | None = None
    tool_policy: str
    position_x: float
    position_y: float
    kind: str = "agent"
    # Lifecycle. Agents and tools are 'ready';
    # pending, provisioning, ready, error and stopped.
    status: str = "ready"
    status_detail: str | None = None
    # Role variable for envNodes user | scratch
    # scratch is the default env that all agents have to spin up artifacts
    # user is the user provisioned environment for any task requiring an environment
    role: str | None = None
    runtime: str | None = None

    @classmethod
    def of(cls, n: Node, agent_slug: str | None = None) -> "NodeResponse":
        """agent_slug defaults to the node's join; pass it on create, before the re-read."""
        config = n.config if n.kind == "environment" else {}
        return cls(
            id=UUID(n.id),
            project_id=UUID(n.project_id),
            name=n.name,
            agent_slug=agent_slug if agent_slug is not None else n.agent_slug,
            tool_policy=n.tool_policy,
            position_x=n.position_x,
            position_y=n.position_y,
            kind=n.kind,
            status=n.status,
            status_detail=n.status_detail,
            role=config.get("role"),
            runtime=config.get("runtime"),
        )


class ToolTypeResponse(BaseModel):
    id: UUID
    slug: str
    name: str
    description: str | None = None
    config_schema: dict[str, Any]
    secret_fields: list[str]
    # token: render a password field. oauth2: render a Connect button.
    auth_kind: str = "token"

    @classmethod
    def of(cls, t: ToolType) -> "ToolTypeResponse":
        return cls(
            id=UUID(t.id),
            slug=t.slug,
            name=t.name,
            description=t.description,
            config_schema=t.config_schema,
            secret_fields=t.secret_fields,
            auth_kind=t.auth_kind,
        )


class ToolPresetResponse(BaseModel):
    id: UUID
    slug: str
    name: str
    description: str | None = None
    tool_slug: str
    config: dict[str, Any]

    @classmethod
    def of(cls, p: ToolPreset) -> "ToolPresetResponse":
        return cls(
            id=UUID(p.id),
            slug=p.slug,
            name=p.name,
            description=p.description,
            tool_slug=p.tool_slug,
            config=p.config,
        )


class ToolNodeResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    kind: str = "tool"
    tool_slug: str
    config: dict[str, Any]
    status: str
    status_detail: str | None = None
    # Names only. Values are never returned.
    secrets_set: list[str] = []
    # Platform keys in effect that the user has not overridden.
    platform_provided: list[str] = []

    @classmethod
    def of(cls, n: ToolNode, secrets_set: list[str]) -> "ToolNodeResponse":
        provided = sorted(k for k in platform_secrets(n.tool_slug) if k not in secrets_set)
        return cls(
            id=UUID(n.id),
            project_id=UUID(n.project_id),
            name=n.name,
            tool_slug=n.tool_slug,
            config=n.config,
            status=n.status,
            status_detail=n.status_detail,
            secrets_set=secrets_set,
            platform_provided=provided,
        )


@router.get("/agent-types", response_model=list[AgentTypeResponse])
async def list_agent_types(repo: ProjectRepo) -> list[AgentTypeResponse]:
    """The palette of agent templates a node can be provisioned from."""
    types = await to_thread.run_sync(repo.list_agent_types)
    return [AgentTypeResponse.of(t) for t in types]


@router.post(
    "/projects/{project_id}/nodes",
    response_model=NodeResponse | ToolNodeResponse | EnvironmentNodeResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_node(
    project_id: UUID,
    req: CreateNodeRequest,
    repo: ProjectRepo,
    tool_repo: ToolRepo,
    env_repo: EnvRepo,
) -> NodeResponse | ToolNodeResponse | EnvironmentNodeResponse:
    """Provision a box on a project's canvas: kind='agent', 'tool' or 'environment'."""
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    if req.kind == "tool":
        return await _create_tool_node(project_id, req, tool_repo)

    if req.kind == "environment":
        return await create_environment_node(project_id, req, env_repo)

    if not req.agent_slug:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="agent_slug is required for kind='agent'",
        )

    agent_type = await to_thread.run_sync(repo.get_agent_type, req.agent_slug)
    if agent_type is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown agent '{req.agent_slug}'",
        )

    node_id = await to_thread.run_sync(
        lambda: repo.create_node(
            str(project_id),
            agent_type.id,
            req.name or agent_type.name,
            position_x=req.position_x,
            position_y=req.position_y,
        )
    )

    # Access requires an edge, so the scratch space is wired like any other
    # environment. The frontend hides this one rather than drawing it.
    scratch = await to_thread.run_sync(lambda: env_repo.ensure_scratch_node(str(project_id)))
    try:
        await to_thread.run_sync(lambda: repo.create_edge(scratch.id, node_id, "environment"))
    except DuplicateEdge:
        # A retried create. The wiring is already there.
        pass

    await _wire_default_presets(project_id, node_id, agent_type, req, repo, tool_repo)

    node = await to_thread.run_sync(repo.get_agent_node, node_id)
    if node is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Node could not be read back after creation",
        )
    return NodeResponse.of(node, agent_type.slug)


@router.get("/projects/{project_id}/nodes", response_model=list[NodeResponse])
async def list_nodes(project_id: UUID, repo: ProjectRepo) -> list[NodeResponse]:
    """List every box on a project's canvas, agents and tools."""
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    nodes = await to_thread.run_sync(repo.list_nodes, str(project_id))
    return [NodeResponse.of(n) for n in nodes]


@router.patch("/projects/{project_id}/nodes/{node_id}", response_model=NodeResponse)
async def update_node(
    project_id: UUID,
    node_id: UUID,
    req: UpdateNodeRequest,
    repo: ProjectRepo,
) -> NodeResponse:
    """Move, rename, or set the tool policy. An empty body is a no-op."""
    node = await to_thread.run_sync(
        lambda: repo.update_node(str(node_id), req.model_dump(exclude_none=True))
    )
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    return NodeResponse.of(node)


@router.delete(
    "/projects/{project_id}/nodes/{node_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_node(
    project_id: UUID, node_id: UUID, repo: ProjectRepo, env_repo: EnvRepo
) -> None:
    """Remove a node of any kind, cascading to its conversation, transcript and secrets."""
    # Kill the sandbox first: the row is about to go, and nothing else knows
    # the id. teardown never raises, so a dead E2B cannot block the delete.
    env = await to_thread.run_sync(env_repo.get_environment_node, str(node_id))
    if env is not None:
        await lifecycle.teardown(env_repo, env)

    deleted = await to_thread.run_sync(repo.delete_node, str(node_id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")


# -- TOOL NODES ------------------------------------------------------------------


def _split_tool_config(
    tool_type: ToolType, config: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, str]]:
    """Split config into plain fields and secrets. Unknown keys are rejected."""
    schema_fields = {f["key"] for f in (tool_type.config_schema.get("fields") or [])}
    secret_field_names = set(tool_type.secret_fields)
    known = schema_fields | secret_field_names

    unknown = set(config) - known
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown config field(s): {', '.join(sorted(unknown))}",
        )

    plain: dict[str, Any] = {}
    secrets: dict[str, str] = {}
    for key, value in config.items():
        if key in secret_field_names:
            secrets[key] = value
        else:
            plain[key] = value
    return plain, secrets


async def _provision_tool_node(
    project_id: UUID,
    tool_type: ToolType,
    name: str,
    config: dict[str, Any],
    secrets: dict[str, str],
    *,
    position_x: float,
    position_y: float,
    tool_repo: ToolRepo,
) -> str:
    """Create a tool row, store its secrets, verify it. Returns the node id.

    Shared by the request path and default wiring. ``config`` is already
    split: plain fields only, with any preset config merged in.
    """
    # Copy the catalog default url when config omits one, keeping the node
    # self-contained against later catalog edits.
    default_url = tool_type.config_schema.get("default_url")
    if default_url and not config.get("url"):
        config = {**config, "url": default_url}

    node_id = await to_thread.run_sync(
        lambda: tool_repo.create_tool_node(
            str(project_id),
            tool_type.id,
            name,
            config,
            position_x=position_x,
            position_y=position_y,
        )
    )

    for key, value in secrets.items():
        await to_thread.run_sync(lambda k=key, v=value: tool_repo.set_secret(node_id, k, v))

    await _verify_tool_node(node_id, tool_repo)
    return node_id


async def _create_tool_node(
    project_id: UUID,
    req: CreateNodeRequest,
    tool_repo: ToolRepo,
) -> ToolNodeResponse:
    """Provision a tool box from a type or a preset: split config, verify."""
    if not req.tool_slug and not req.preset_slug:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="tool_slug or preset_slug is required for kind='tool'",
        )
    if req.tool_slug and req.preset_slug:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Send tool_slug or preset_slug, not both",
        )

    preset = None
    tool_slug = req.tool_slug
    if req.preset_slug:
        preset = await to_thread.run_sync(tool_repo.get_preset, req.preset_slug)
        if preset is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown preset '{req.preset_slug}'",
            )
        tool_slug = preset.tool_slug

    tool_type = await to_thread.run_sync(tool_repo.get_tool_type, tool_slug)
    if tool_type is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown tool '{tool_slug}'",
        )

    plain_config, secrets = _split_tool_config(tool_type, req.config)
    if preset is not None:
        # Preset is the base, the request overrides. Preset config is trusted
        # and merged after the split, so it is not checked against the form.
        plain_config = {**preset.config, **plain_config}

    name = req.name or (preset.name if preset else tool_type.name)
    node_id = await _provision_tool_node(
        project_id,
        tool_type,
        name,
        plain_config,
        secrets,
        position_x=req.position_x,
        position_y=req.position_y,
        tool_repo=tool_repo,
    )

    node = await to_thread.run_sync(tool_repo.get_tool_node, node_id)
    if node is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Node could not be read back after creation",
        )
    secrets_set = await to_thread.run_sync(tool_repo.secret_keys, node_id)
    return ToolNodeResponse.of(node, secrets_set)


async def _wire_default_presets(
    project_id: UUID,
    node_id: str,
    agent_type: AgentType,
    req: CreateNodeRequest,
    repo: ProjectRepo,
    tool_repo: ToolRepo,
) -> None:
    """Create and connect the presets an agent type lists.

    Each preset is independent: an unknown slug or a failed create is logged
    and skipped, never raised, so a typo in a seed cannot block creating an
    agent. Not transactional, by the same reasoning as the scratch edge: a
    half-wired agent is visible and deletable. Nothing here is idempotent: a
    retried request creates a second agent and a second set of defaults.
    """
    created: list[str] = []
    for slug in agent_type.default_presets:
        preset = await to_thread.run_sync(tool_repo.get_preset, slug)
        if preset is None:
            log.warning("agent type %s lists unknown preset %s", agent_type.slug, slug)
            continue
        tool_type = await to_thread.run_sync(tool_repo.get_tool_type, preset.tool_slug)
        if tool_type is None:
            log.warning("preset %s names unknown tool type %s", slug, preset.tool_slug)
            continue
        try:
            tool_id = await _provision_tool_node(
                project_id,
                tool_type,
                preset.name,
                dict(preset.config),
                {},
                position_x=req.position_x + _DEFAULT_TOOL_DX,
                position_y=req.position_y + len(created) * _DEFAULT_TOOL_DY,
                tool_repo=tool_repo,
            )
        except Exception:
            log.exception("default preset %s failed for agent %s", slug, node_id)
            continue
        created.append(tool_id)
        try:
            await to_thread.run_sync(lambda t=tool_id: repo.create_edge(t, node_id, "tool"))
        except Exception:
            # The tool node exists with no edge. Named so it can be cleaned up.
            log.exception("edge for preset %s failed; orphan tool node %s", slug, tool_id)


async def _verify_tool_node(node_id: str, tool_repo: ToolRepo) -> None:
    """Run the node's spec.verify and persist the outcome. Failures write status, never raise."""
    node = await to_thread.run_sync(tool_repo.get_tool_node, node_id)
    if node is None:
        return

    spec = get_spec(node.tool_slug)
    if spec is None:
        await to_thread.run_sync(
            lambda: tool_repo.set_node_status(node.id, "error", f"Unknown tool '{node.tool_slug}'")
        )
        return

    keys = await to_thread.run_sync(tool_repo.secret_keys, node.id)
    try:
        secrets = await to_thread.run_sync(lambda: load_node_secrets(node.id, keys))
    except RuntimeError:
        await to_thread.run_sync(
            lambda: tool_repo.set_node_status(node.id, "error", "Secrets are unavailable")
        )
        return

    secrets = {**platform_secrets(node.tool_slug), **secrets}
    try:
        secrets = await with_access_token(node.tool_slug, node.id, secrets)
    except TokenExchangeError:
        # Revoked at Google. Never retry, let the node go to error.
        await to_thread.run_sync(
            lambda: tool_repo.set_node_status(
                node.id, "error", "Access was revoked. Reconnect the node."
            )
        )
        return

    result = await spec.verify(ToolContext(node.id, node.name, node.config, secrets))

    if result.discovered_tools is not None:
        merged_config = dict(node.config)
        merged_config["discovered_tools"] = result.discovered_tools
        await to_thread.run_sync(lambda: tool_repo.set_node_config(node.id, merged_config))

    await to_thread.run_sync(
        lambda: tool_repo.set_node_status(node.id, "ready" if result.ok else "error", result.detail)
    )


@router.get("/tool-types", response_model=list[ToolTypeResponse])
async def list_tool_types(tool_repo: ToolRepo) -> list[ToolTypeResponse]:
    """The palette of tool templates a node can be provisioned from."""
    types = await to_thread.run_sync(tool_repo.list_tool_types)
    return [ToolTypeResponse.of(t) for t in types]


@router.get("/tool-presets", response_model=list[ToolPresetResponse])
async def list_tool_presets(tool_repo: ToolRepo) -> list[ToolPresetResponse]:
    """The library of ready-to-instantiate tools and skills."""
    presets = await to_thread.run_sync(tool_repo.list_presets)
    return [ToolPresetResponse.of(p) for p in presets]


@router.post(
    "/projects/{project_id}/nodes/{node_id}/verify",
    response_model=ToolNodeResponse,
)
async def verify_tool_node(
    project_id: UUID,
    node_id: UUID,
    tool_repo: ToolRepo,
) -> ToolNodeResponse:
    """Re-run a tool node's connectivity check and persist the result."""
    node = await to_thread.run_sync(tool_repo.get_tool_node, str(node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tool node not found")

    await _verify_tool_node(str(node_id), tool_repo)

    updated = await to_thread.run_sync(tool_repo.get_tool_node, str(node_id))
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tool node not found")
    secrets_set = await to_thread.run_sync(tool_repo.secret_keys, str(node_id))
    return ToolNodeResponse.of(updated, secrets_set)


@router.get("/projects/{project_id}/nodes/{node_id}/tool-calls")
async def list_tool_calls(
    project_id: UUID,
    node_id: UUID,
    tool_repo: ToolRepo,
    limit: int = Query(50, ge=1, le=200),
) -> list[dict[str, Any]]:
    """The audit log of calls made against one tool node."""
    node = await to_thread.run_sync(tool_repo.get_tool_node, str(node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tool node not found")
    return await to_thread.run_sync(lambda: tool_repo.list_calls(str(node_id), limit))


# -- EDGES ---------------------------------------------------------------------


# Each edge kind runs between one pair of node kinds, source first.
_EDGE_ENDPOINTS: dict[str, tuple[str, str]] = {
    "context": ("agent", "agent"),
    "tool": ("tool", "agent"),
    "environment": ("environment", "agent"),
}


class CreateEdgeRequest(BaseModel):
    source_node_id: UUID
    target_node_id: UUID
    kind: Literal["context", "tool", "environment"] = "context"


class EdgeResponse(BaseModel):
    id: UUID
    source_node_id: UUID
    target_node_id: UUID
    kind: str
    is_stale: bool
    # 0 when fresh, null when never summarised.
    messages_behind: int | None = None
    summarised_through_seq: int | None = None
    summary_updated_at: datetime | None = None

    @classmethod
    def of(cls, e: Edge, is_stale: bool, messages_behind: int | None = None) -> "EdgeResponse":
        return cls(
            id=e.id,
            source_node_id=e.source_node_id,
            target_node_id=e.target_node_id,
            kind=e.kind,
            is_stale=is_stale,
            messages_behind=messages_behind,
            summarised_through_seq=e.summarised_through_seq,
            summary_updated_at=e.summary_updated_at,
        )


@router.post(
    "/projects/{project_id}/edges", response_model=EdgeResponse, status_code=status.HTTP_201_CREATED
)
async def create_edge(
    project_id: UUID,
    req: CreateEdgeRequest,
    repo: ProjectRepo,
    tool_repo: ToolRepo,
    env_repo: EnvRepo,
) -> EdgeResponse:
    """Create an edge between two nodes on the canvas."""

    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    # Load both endpoints, check they belong to this project, then check the
    # kind pair this edge kind allows.
    required_kinds = _EDGE_ENDPOINTS[req.kind]
    node_ids = (req.source_node_id, req.target_node_id)
    actual_kinds: list[str] = []
    for node_id in node_ids:
        agent_node = await to_thread.run_sync(repo.get_agent_node, str(node_id))
        if agent_node is not None and agent_node.project_id == str(project_id):
            actual_kinds.append("agent")
            continue
        tool_node = await to_thread.run_sync(tool_repo.get_tool_node, str(node_id))
        if tool_node is not None and tool_node.project_id == str(project_id):
            actual_kinds.append("tool")
            continue
        env_node = await to_thread.run_sync(env_repo.get_environment_node, str(node_id))
        if env_node is not None and env_node.project_id == str(project_id):
            actual_kinds.append("environment")
            continue
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")

    if tuple(actual_kinds) != required_kinds:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"'{req.kind}' edges run {required_kinds[0]} to {required_kinds[1]}, "
                f"not {actual_kinds[0]} to {actual_kinds[1]}"
            ),
        )

    # Create the edge, mapping duplicate and invalid endpoint errors.
    try:
        edge = await to_thread.run_sync(
            lambda: repo.create_edge(
                str(req.source_node_id),
                str(req.target_node_id),
                req.kind,
            )
        )
    except DuplicateEdge as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That edge already exists",
        ) from exc
    except APIError as exc:
        if exc.code == "23514":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Invalid edge: a node cannot be its own source and target"
                "nodes must belong to this project",
            ) from exc
        raise

    # A new edge is always stale.
    return EdgeResponse.of(edge, is_stale=True)


@router.get("/projects/{project_id}/edges", response_model=list[EdgeResponse])
async def list_edges(project_id: UUID, repo: ProjectRepo) -> list[EdgeResponse]:
    """List the edges on a project's canvas."""
    # Check the project before listing edges.
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    edges = await to_thread.run_sync(repo.list_edges, str(project_id))

    # One head lookup per edge.
    out = []
    for e in edges:
        head = await to_thread.run_sync(repo.get_conversation_head, e.source_node_id)
        if e.summarised_through_seq is None:
            # Never summarised: stale, with no meaningful gap.
            out.append(EdgeResponse.of(e, is_stale=True, messages_behind=None))
            continue
        behind = max(0, head - e.summarised_through_seq)
        out.append(EdgeResponse.of(e, is_stale=behind > 0, messages_behind=behind))
    return out


@router.delete("/projects/{project_id}/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_edge(project_id: UUID, edge_id: UUID, repo: ProjectRepo) -> None:
    """Remove an edge from the canvas."""
    # Check the project before deleting.
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    deleted = await to_thread.run_sync(repo.delete_edge, str(edge_id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Edge not found")


# -- STALE CONTEXT CHECK ----------------------------------------------------------------


@router.post("/projects/{project_id}/edges/{edge_id}/refresh", response_model=EdgeResponse)
async def refresh_edge_summary(project_id: UUID, edge_id: UUID, repo: ProjectRepo) -> EdgeResponse:
    """Regenerate a context edge's summary from its source conversation."""
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    edge = await to_thread.run_sync(repo.get_edge, str(edge_id))
    if edge is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Edge not found")
    if edge.kind != "context":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only context edges carry a summary",
        )

    conversation_id = await to_thread.run_sync(repo.get_conversation_for_node, edge.source_node_id)
    if conversation_id is None:
        # Nothing to summarise; record it so the edge stops reading as stale.
        updated = await to_thread.run_sync(lambda: repo.update_edge_summary(str(edge_id), "", 0))
        return EdgeResponse.of(updated or edge, is_stale=False, messages_behind=0)

    # Read before summarising, so a message landing mid-call re-stales the edge.
    head = await to_thread.run_sync(repo.get_conversation_head, edge.source_node_id)
    history = await to_thread.run_sync(repo.list_messages, conversation_id)

    summary = await summarise_conversation(history, max_words=edge.summary_max_words)

    updated = await to_thread.run_sync(
        lambda: repo.update_edge_summary(str(edge_id), summary, head)
    )
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Summary could not be stored",
        )
    return EdgeResponse.of(updated, is_stale=False, messages_behind=0)
