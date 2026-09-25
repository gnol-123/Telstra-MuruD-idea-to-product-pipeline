"""Projects and the agent nodes provisioned inside them."""

import asyncio
import logging
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

import anyio
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
    UsageTotal,
)
from app.repositories.tool_repo import (
    ToolNode,
    ToolPreset,
    ToolRepository,
    ToolType,
    load_node_secrets,
)
from app.routers.chat import ChatMessage
from app.routers.deps import EnvRepo, ProjectRepo, ToolRepo, TurnRepos
from app.routers.environments import EnvironmentNodeResponse, create_environment_node
from app.services.models import ModelsUnavailable, list_models
from app.tools.base import ToolContext
from app.tools.oauth_refresh import TokenExchangeError, with_access_token
from app.tools.registry import get_spec, platform_secrets
from app.workflows import cancel_for_node, cancel_for_project, refresh_edge

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


async def _wrong_kind_detail(node_id: UUID, tool_repo: ToolRepo, env_repo: EnvRepo) -> str:
    """Explain a PATCH miss: wrong route, or genuinely no such node."""
    env = await to_thread.run_sync(env_repo.get_environment_node, str(node_id))
    if env is not None:
        return (
            "That node is an environment, and this route updates agents. "
            "Use PATCH /projects/{project_id}/environments/{node_id}."
        )
    tool = await to_thread.run_sync(tool_repo.get_tool_node, str(node_id))
    if tool is not None:
        return (
            "That node is a tool, and this route updates agents. A tool node has no "
            "patch route: re-check it with POST /projects/{project_id}/nodes/{node_id}/verify, "
            "or delete it and create it again to change its config."
        )
    return "Node not found"


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: UUID, repo: ProjectRepo, env_repo: EnvRepo) -> None:
    """Delete a project, cascading to its nodes, edges, conversations and messages."""
    # Stop every running turn first: otherwise it keeps writing into a
    # conversation the delete is about to cascade away.
    await cancel_for_project(str(project_id))

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
    # Agent nodes only. 'auto' for an orchestrator that should run unattended.
    tool_policy: Literal["ask", "auto"] = "ask"


class UpdateNodeRequest(BaseModel):
    """Partial update. Only the fields sent are changed. node_type and owner_id are fixed."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    position_x: float | None = None
    position_y: float | None = None
    tool_policy: Literal["ask", "auto"] | None = None
    model: str | None = Field(default=None, max_length=200)


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
    # The model this node actually runs on: its own override, else its type's.
    model: str | None = None

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
            model=n.model or None,
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


async def provision_agent(
    project_id: str,
    agent_type: AgentType,
    name: str,
    *,
    position_x: float,
    position_y: float,
    tool_policy: str,
    repo: ProjectRepo,
    tool_repo: ToolRepo,
    env_repo: EnvRepo,
) -> str:
    """Create an agent box with its conversation, scratch access and default tools.

    The agent branch of POST /nodes, shared with the canvas tool so an
    orchestrator-made agent is indistinguishable from a user-made one.
    """
    node_id = await to_thread.run_sync(
        lambda: repo.create_node(
            project_id,
            agent_type.id,
            name,
            position_x=position_x,
            position_y=position_y,
            tool_policy=tool_policy,
        )
    )

    # Access requires an edge, so the scratch space is wired like any other
    # environment. The frontend hides this one rather than drawing it.
    scratch = await to_thread.run_sync(lambda: env_repo.ensure_scratch_node(project_id))
    try:
        await to_thread.run_sync(lambda: repo.create_edge(scratch.id, node_id, "environment"))
    except DuplicateEdge:
        # A retried create. The wiring is already there.
        pass

    req = CreateNodeRequest(
        agent_slug=agent_type.slug, position_x=position_x, position_y=position_y
    )
    await _wire_default_presets(project_id, node_id, agent_type, req, repo, tool_repo)
    return node_id


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

    node_id = await provision_agent(
        str(project_id),
        agent_type,
        req.name or agent_type.name,
        position_x=req.position_x,
        position_y=req.position_y,
        tool_policy=req.tool_policy,
        repo=repo,
        tool_repo=tool_repo,
        env_repo=env_repo,
    )

    node = await to_thread.run_sync(repo.get_agent_node, node_id)
    if node is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Node could not be read back after creation",
        )
    return NodeResponse.of(node, agent_type.slug)


class UsageModelResponse(BaseModel):
    """Totals for one model. `reasoning_tokens` is inside `output_tokens`."""

    model: str
    input_tokens: int
    output_tokens: int
    reasoning_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    requests: int
    message_count: int


class UsageResponse(BaseModel):
    """Per-model breakdown plus totals of the columns that are safely additive.

    No grand total of output+reasoning: reasoning is a subset of output, so
    adding them double-counts. Totals across models are token counts only,
    never a cost: prices differ per model, so a cap set on these numbers is a
    token budget, not a spend budget.

    `project_id` is null on the account-wide route.
    """

    project_id: UUID | None = None
    by_model: list[UsageModelResponse]
    input_tokens: int
    output_tokens: int
    message_count: int

    @classmethod
    def of(cls, totals: list[UsageTotal], project_id: UUID | None = None) -> "UsageResponse":
        return cls(
            project_id=project_id,
            by_model=[UsageModelResponse(**vars(t)) for t in totals],
            input_tokens=sum(t.input_tokens for t in totals),
            output_tokens=sum(t.output_tokens for t in totals),
            message_count=sum(t.message_count for t in totals),
        )


@router.get("/usage", response_model=UsageResponse)
async def get_user_usage(repo: ProjectRepo) -> UsageResponse:
    """This user's token usage across every project. What a cap reads.

    Already scoped to the caller: there is no route to another user's usage.
    """
    return UsageResponse.of(await to_thread.run_sync(repo.get_user_usage))


@router.get("/projects/{project_id}/usage", response_model=UsageResponse)
async def get_usage(project_id: UUID, repo: ProjectRepo) -> UsageResponse:
    """This user's token usage in one project, broken down by model."""
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    totals = await to_thread.run_sync(repo.get_usage, str(project_id))
    return UsageResponse.of(totals, project_id)


@router.get("/projects/{project_id}/nodes", response_model=list[NodeResponse])
async def list_nodes(project_id: UUID, repo: ProjectRepo) -> list[NodeResponse]:
    """List every box on a project's canvas, agents and tools."""
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    nodes = await to_thread.run_sync(repo.list_nodes, str(project_id))
    return [NodeResponse.of(n) for n in nodes]


@router.get("/projects/{project_id}/nodes/{node_id}/messages", response_model=list[ChatMessage])
async def list_node_messages(
    project_id: UUID,
    node_id: UUID,
    turn_repos: TurnRepos,
    after_seq: int = Query(default=0, ge=0),
) -> list[ChatMessage]:
    """An agent node's transcript, oldest first. ``after_seq`` for polling.

    Reads on the pooled service client (TurnRepos), not a fresh per-request
    user client: get_user_client deliberately builds a brand new httpx.Client
    (and pays a cold TLS handshake) on every call.

    No separate project lookup: get_agent_node is owner-filtered and
    its project_id is checked below.
    """
    repo = turn_repos.project
    node = await to_thread.run_sync(repo.get_agent_node, str(node_id))
    if node is None or node.project_id != str(project_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    conversation_id = await to_thread.run_sync(repo.get_conversation_for_node, node.id)
    if conversation_id is None:
        return []
    messages = await to_thread.run_sync(
        lambda: repo.list_messages_after(conversation_id, after_seq=after_seq)
    )
    return [ChatMessage.of(m) for m in messages]


@router.patch("/projects/{project_id}/nodes/{node_id}", response_model=NodeResponse)
async def update_node(
    project_id: UUID,
    node_id: UUID,
    req: UpdateNodeRequest,
    repo: ProjectRepo,
    tool_repo: ToolRepo,
    env_repo: EnvRepo,
) -> NodeResponse:
    """Move, rename, set the tool policy, or set the model. Empty body is a no-op.

    A model is checked against the provider's catalogue first, so a typo is a
    422 here rather than a failed turn later. "" clears the override.
    """
    changes = req.model_dump(exclude_none=True)
    if req.model:
        try:
            available = await list_models()
        except ModelsUnavailable as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="The model catalogue is unavailable, so a model cannot be validated.",
            ) from exc
        if req.model not in available:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Unknown model '{req.model}'. Available: {', '.join(available)}",
            )

    node = await to_thread.run_sync(lambda: repo.update_node(str(node_id), changes))
    if node is None:
        # This route only updates agents. A miss is usually the right node on
        # the wrong URL, so say which route owns it rather than "not found".
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=await _wrong_kind_detail(node_id, tool_repo, env_repo),
        )
    return NodeResponse.of(node)


class DeleteNodeResponse(BaseModel):
    # The clicked node, plus any tool nodes orphaned by removing it.
    deleted_node_ids: list[UUID]


@router.delete(
    "/projects/{project_id}/nodes/{node_id}",
    response_model=DeleteNodeResponse,
)
async def delete_node(
    project_id: UUID, node_id: UUID, repo: ProjectRepo, env_repo: EnvRepo
) -> DeleteNodeResponse:
    """Remove a node of any kind, cascading to its conversation, transcript and secrets."""
    # Stop a running turn first: only agent nodes have a conversation, so a
    # tool/environment node's None id is a no-op.
    conversation_id = await to_thread.run_sync(repo.get_conversation_for_node, str(node_id))
    await cancel_for_node(conversation_id)

    # Kill the sandbox first: the row is about to go, and nothing else knows
    # the id. teardown never raises, so a dead E2B cannot block the delete.
    env = await to_thread.run_sync(env_repo.get_environment_node, str(node_id))
    if env is not None:
        await lifecycle.teardown(env_repo, env)

    deleted = await to_thread.run_sync(repo.delete_node, str(node_id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")
    return DeleteNodeResponse(deleted_node_ids=deleted)


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
    project_id: str,
    tool_type: ToolType,
    name: str,
    config: dict[str, Any],
    secrets: dict[str, str],
    *,
    position_x: float,
    position_y: float,
    tool_repo: ToolRepo,
    verify: bool = True,
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
            project_id,
            tool_type.id,
            name,
            config,
            position_x=position_x,
            position_y=position_y,
        )
    )

    for key, value in secrets.items():
        await to_thread.run_sync(lambda k=key, v=value: tool_repo.set_secret(node_id, k, v))

    if verify:
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
        str(project_id),
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


def _load_catalog(
    tool_repo: ToolRepository,
) -> tuple[dict[str, ToolPreset], dict[str, ToolType]]:
    """The preset and tool type catalogs, keyed by slug. Two reads, not two per preset."""
    return (
        {p.slug: p for p in tool_repo.list_presets()},
        {t.slug: t for t in tool_repo.list_tool_types()},
    )


async def _wire_default_presets(
    project_id: str,
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
    if not agent_type.default_presets:
        return

    # Two catalog reads instead of two per preset: these rows are static for
    # the life of the request, and a 12 preset agent was paying 24 round
    # trips to re-read them.
    presets, tool_types = await to_thread.run_sync(_load_catalog, tool_repo)

    # Slot index is fixed up front so the presets can run concurrently
    # without their positions depending on completion order.
    planned: list[tuple[int, ToolPreset, ToolType]] = []
    for slug in agent_type.default_presets:
        preset = presets.get(slug)
        if preset is None:
            log.warning("agent type %s lists unknown preset %s", agent_type.slug, slug)
            continue
        tool_type = tool_types.get(preset.tool_slug)
        if tool_type is None:
            log.warning("preset %s names unknown tool type %s", slug, preset.tool_slug)
            continue
        planned.append((len(planned), preset, tool_type))

    async def wire(slot: int, preset: ToolPreset, tool_type: ToolType) -> None:
        try:
            tool_id = await _provision_tool_node(
                project_id,
                tool_type,
                preset.name,
                dict(preset.config),
                {},
                position_x=req.position_x + _DEFAULT_TOOL_DX,
                position_y=req.position_y + slot * _DEFAULT_TOOL_DY,
                tool_repo=tool_repo,
                verify=False,
            )
        except Exception:
            log.exception("default preset %s failed for agent %s", preset.slug, node_id)
            return
        tool_ids.append(tool_id)
        try:
            await to_thread.run_sync(lambda t=tool_id: repo.create_edge(t, node_id, "tool"))
        except Exception:
            # The tool node exists with no edge. Named so it can be cleaned up.
            log.exception("edge for preset %s failed; orphan tool node %s", preset.slug, tool_id)

    # Each preset is independent, so wire them at once rather than paying
    # ~6 sequential round trips each. gather never raises: wire swallows.
    tool_ids: list[str] = []
    async with anyio.create_task_group() as tg:
        for slot, preset, tool_type in planned:
            tg.start_soon(wire, slot, preset, tool_type)

    # Verify hits the network (MCP handshake, API ping) and was gating the
    # response. Rows sit at 'pending' until it lands; the canvas poll shows it.
    task = asyncio.create_task(_verify_all(tool_ids, tool_repo))
    _background.add(task)
    task.add_done_callback(_background.discard)


# Strong refs so the loop doesn't GC a running verify.
_background: set[asyncio.Task] = set()


async def _verify_all(tool_ids: list[str], tool_repo: ToolRepo) -> None:
    async def one(tool_id: str) -> None:
        try:
            await _verify_tool_node(tool_id, tool_repo)
        except Exception:
            log.exception("background verify failed for tool node %s", tool_id)
            # Never leave it 'pending': the canvas spins its agent until it isn't.
            try:
                await to_thread.run_sync(
                    lambda: tool_repo.set_node_status(tool_id, "error", "Verification failed.")
                )
            except Exception:
                log.exception("could not mark tool node %s as error", tool_id)

    async with anyio.create_task_group() as tg:
        for tool_id in tool_ids:
            tg.start_soon(one, tool_id)


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


@router.get("/models", response_model=list[str])
async def list_available_models() -> list[str]:
    """Model names the configured provider serves, for a per-node model picker."""
    try:
        return await list_models()
    except ModelsUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The model catalogue is unavailable.",
        ) from exc


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

    # One head lookup per context edge, cached per source node: a canvas of
    # tool edges was paying two Supabase round trips each for a staleness
    # number only context edges carry.
    heads: dict[str, int] = {}
    out = []
    for e in edges:
        if e.kind != "context":
            out.append(EdgeResponse.of(e, is_stale=False, messages_behind=None))
            continue
        if e.summarised_through_seq is None:
            # Never summarised: stale, with no meaningful gap.
            out.append(EdgeResponse.of(e, is_stale=True, messages_behind=None))
            continue
        if e.source_node_id not in heads:
            heads[e.source_node_id] = await to_thread.run_sync(
                repo.get_conversation_head, e.source_node_id
            )
        behind = max(0, heads[e.source_node_id] - e.summarised_through_seq)
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

    updated = await refresh_edge(repo, edge)
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Summary could not be stored",
        )
    # Re-read the head: a turn can complete while the summariser runs.
    head = await to_thread.run_sync(repo.get_conversation_head, updated.source_node_id)
    behind = max(0, head - (updated.summarised_through_seq or 0))
    return EdgeResponse.of(updated, is_stale=behind > 0, messages_behind=behind)
