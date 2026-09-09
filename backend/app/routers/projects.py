"""Projects and the agent nodes provisioned inside them."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from anyio import to_thread
from fastapi import APIRouter, HTTPException, status
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field

from app.repositories.chat_repo import (
    AgentNode,
    AgentType,
    DuplicateEdge,
    DuplicateProjectName,
    Edge,
    Project,
)
from app.routers.deps import ChatRepo
from app.services.agent import summarise_conversation

router = APIRouter(tags=["projects"])


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
async def create_project(req: CreateProjectRequest, repo: ChatRepo) -> ProjectResponse:
    try:
        project = await to_thread.run_sync(lambda: repo.create_project(req.name, req.description))
    except DuplicateProjectName as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You already have a project named '{req.name}'",
        ) from exc
    return ProjectResponse.of(project)


@router.get("/projects", response_model=list[ProjectResponse])
async def list_projects(repo: ChatRepo) -> list[ProjectResponse]:
    projects = await to_thread.run_sync(repo.list_projects)
    return [ProjectResponse.of(p) for p in projects]


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: UUID, repo: ChatRepo) -> None:
    """Delete a project and its whole canvas.

    Irreversible: every node, edge, conversation and message in the project
    goes with it.
    """
    deleted = await to_thread.run_sync(repo.delete_project, str(project_id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")


# -- AGENT NODES ---------------------------------------------------------------


class AgentTypeResponse(BaseModel):
    id: UUID
    slug: str
    name: str

    @classmethod
    def of(cls, a: AgentType) -> "AgentTypeResponse":
        return cls(id=UUID(a.id), slug=a.slug, name=a.name)


class CreateAgentNodeRequest(BaseModel):
    # The catalog slug, so the frontend need not resolve UUIDs to provision.
    agent_slug: str = Field(min_length=1, max_length=50)
    # Defaults to the template's name if omitted.
    name: str | None = Field(default=None, min_length=1, max_length=200)
    position_x: float = 0
    position_y: float = 0


class UpdateAgentNodeRequest(BaseModel):
    """A partial update. Only the fields sent are changed. no-op if the body is empty.
    Does not allow changing of node_type and owner_id.
    """

    name: str | None = Field(default=None, min_length=1, max_length=200)
    position_x: float | None = None
    position_y: float | None = None
    tool_policy: Literal["ask", "auto"] | None = None


class AgentNodeResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    agent_slug: str | None = None
    tool_policy: str
    position_x: float
    position_y: float

    @classmethod
    def of(cls, n: AgentNode, agent_slug: str | None = None) -> "AgentNodeResponse":
        return cls(
            id=UUID(n.id),
            project_id=UUID(n.project_id),
            name=n.name,
            agent_slug=agent_slug,
            tool_policy=n.tool_policy,
            position_x=n.position_x,
            position_y=n.position_y,
        )


@router.get("/agent-types", response_model=list[AgentTypeResponse])
async def list_agent_types(repo: ChatRepo) -> list[AgentTypeResponse]:
    """The palette of agent templates a node can be provisioned from."""
    types = await to_thread.run_sync(repo.list_agent_types)
    return [AgentTypeResponse.of(t) for t in types]


@router.post(
    "/projects/{project_id}/nodes",
    response_model=AgentNodeResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_agent_node(
    project_id: UUID,
    req: CreateAgentNodeRequest,
    repo: ChatRepo,
) -> AgentNodeResponse:
    """Provision an agent box on a project's canvas."""
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    agent_type = await to_thread.run_sync(repo.get_agent_type, req.agent_slug)
    if agent_type is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown agent '{req.agent_slug}'",
        )

    node_id = await to_thread.run_sync(
        lambda: repo.create_agent_node(
            str(project_id),
            agent_type.id,
            req.name or agent_type.name,
            position_x=req.position_x,
            position_y=req.position_y,
        )
    )

    node = await to_thread.run_sync(repo.get_agent_node, node_id)
    if node is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Node could not be read back after creation",
        )
    return AgentNodeResponse.of(node, agent_type.slug)


@router.get("/projects/{project_id}/nodes", response_model=list[AgentNodeResponse])
async def list_agent_nodes(project_id: UUID, repo: ChatRepo) -> list[AgentNodeResponse]:
    """List the agent boxes on a project's canvas."""
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    nodes = await to_thread.run_sync(repo.list_agent_nodes, str(project_id))
    return [AgentNodeResponse.of(n) for n in nodes]


@router.patch("/projects/{project_id}/nodes/{node_id}", response_model=AgentNodeResponse)
async def update_agent_node(
    project_id: UUID,
    node_id: UUID,
    req: UpdateAgentNodeRequest,
    repo: ChatRepo,
) -> AgentNodeResponse:
    """Update a node. Used for dragging a box, renaming it, or toggling its
    tool policy. An empty body is a no-op rather than an error."""
    node = await to_thread.run_sync(
        lambda: repo.update_agent_node(str(node_id), req.model_dump(exclude_none=True))
    )
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    return AgentNodeResponse.of(node)


@router.delete(
    "/projects/{project_id}/nodes/{node_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_agent_node(project_id: UUID, node_id: UUID, repo: ChatRepo) -> None:
    """Remove a node, along with its conversation and transcript."""
    deleted = await to_thread.run_sync(repo.delete_agent_node, str(node_id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")


# -- EDGES ---------------------------------------------------------------------


class CreateEdgeRequest(BaseModel):
    source_node_id: UUID
    target_node_id: UUID
    kind: Literal["context"] = "context"


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
async def create_edge(project_id: UUID, req: CreateEdgeRequest, repo: ChatRepo) -> EdgeResponse:
    """Create an edge between two nodes on the canvas."""

    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    # Checks that node exists and belongs to this project.
    for node_id in (req.source_node_id, req.target_node_id):
        node = await to_thread.run_sync(repo.get_agent_node, str(node_id))
        if node is None or node.project_id != str(project_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    # Create Edge and checks duplicate and invalid edge errors.
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
async def list_edges(project_id: UUID, repo: ChatRepo) -> list[EdgeResponse]:
    """List the edges on a project's canvas."""
    # Check valid project_id before listing edges.f
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
async def delete_edge(project_id: UUID, edge_id: UUID, repo: ChatRepo) -> None:
    """Remove an edge from the canvas."""
    # Check valid project_id before deleting edge.
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    deleted = await to_thread.run_sync(repo.delete_edge, str(edge_id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Edge not found")


# -- STALE CONTEXT CHECK ----------------------------------------------------------------


@router.post("/projects/{project_id}/edges/{edge_id}/refresh", response_model=EdgeResponse)
async def refresh_edge_summary(project_id: UUID, edge_id: UUID, repo: ChatRepo) -> EdgeResponse:
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
