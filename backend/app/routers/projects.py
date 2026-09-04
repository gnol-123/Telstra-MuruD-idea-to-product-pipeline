"""Projects and the agent nodes provisioned inside them."""

from uuid import UUID

from anyio import to_thread
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.repositories.chat_repo import AgentNode, AgentType, Project
from app.routers.deps import ChatRepo

router = APIRouter(tags=["projects"])


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class ProjectResponse(BaseModel):
    id: UUID
    name: str

    @classmethod
    def of(cls, p: Project) -> "ProjectResponse":
        return cls(id=UUID(p.id), name=p.name)


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


class AgentNodeResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    agent_slug: str | None = None
    tool_policy: str

    @classmethod
    def of(cls, n: AgentNode, agent_slug: str | None = None) -> "AgentNodeResponse":
        return cls(
            id=UUID(n.id),
            project_id=UUID(n.project_id),
            name=n.name,
            agent_slug=agent_slug,
            tool_policy=n.tool_policy,
        )


@router.get("/agent-types", response_model=list[AgentTypeResponse])
async def list_agent_types(repo: ChatRepo) -> list[AgentTypeResponse]:
    """The palette of agent templates a node can be provisioned from."""
    types = await to_thread.run_sync(repo.list_agent_types)
    return [AgentTypeResponse.of(t) for t in types]


@router.post("/projects", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(req: CreateProjectRequest, repo: ChatRepo) -> ProjectResponse:
    project = await to_thread.run_sync(lambda: repo.create_project(req.name, req.description))
    return ProjectResponse.of(project)


@router.get("/projects", response_model=list[ProjectResponse])
async def list_projects(repo: ChatRepo) -> list[ProjectResponse]:
    projects = await to_thread.run_sync(repo.list_projects)
    return [ProjectResponse.of(p) for p in projects]


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
    project = await to_thread.run_sync(repo.get_project, str(project_id))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    nodes = await to_thread.run_sync(repo.list_agent_nodes, str(project_id))
    return [AgentNodeResponse.of(n) for n in nodes]
