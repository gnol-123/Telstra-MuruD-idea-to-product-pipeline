"""Environment nodes: the lifecycle endpoints.

Creation lives on POST /projects/{id}/nodes with kind='environment', beside
agents and tools, because the canvas creates all three the same way. Only
create_environment_node is exported for that; everything else is a route here.
"""

import posixpath
from typing import Any, Literal
from uuid import UUID

from anyio import to_thread
from e2b import AsyncSandbox, FileNotFoundException, FileType
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.config import settings
from app.environments import e2b, lifecycle
from app.environments.base import WORKSPACE_ROOT, EnvContext
from app.repositories.environment_repo import EnvNode
from app.routers.deps import EnvRepo

router = APIRouter(prefix="/projects/{project_id}/environments", tags=["environments"])

# What a client may set at create time. Everything else about an environment
# is the backend's: runtime, role, and the sandbox id in particular.
_CREATE_CONFIG_KEYS = ("template", "idle_timeout_s", "preview_ports", "description")


class EnvironmentNodeResponse(BaseModel):
    id: UUID
    project_id: UUID
    kind: str = "environment"
    name: str
    runtime: str
    role: str
    status: str
    status_detail: str | None = None
    tool_policy: str
    position_x: float
    position_y: float
    sandbox_id: str | None = None
    template: str | None = None
    idle_timeout_s: int | None = None
    preview_ports: list[int] = []
    description: str | None = None

    @classmethod
    def of(cls, n: EnvNode) -> "EnvironmentNodeResponse":
        return cls(
            id=UUID(n.id),
            project_id=UUID(n.project_id),
            name=n.name,
            runtime=n.runtime,
            role=n.role,
            status=n.status,
            status_detail=n.status_detail,
            tool_policy=n.tool_policy,
            position_x=n.position_x,
            position_y=n.position_y,
            sandbox_id=n.sandbox_id,
            template=n.config.get("template"),
            idle_timeout_s=n.config.get("idle_timeout_s"),
            preview_ports=n.config.get("preview_ports") or [],
            description=n.config.get("description"),
        )


class UpdateEnvironmentRequest(BaseModel):
    """Partial update. Status, config and kind are not client writable."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    position_x: float | None = None
    position_y: float | None = None
    tool_policy: Literal["ask", "auto"] | None = None


class FileEntry(BaseModel):
    name: str
    type: str
    path: str
    size: int = 0


class FileListResponse(BaseModel):
    path: str
    entries: list[FileEntry]


class FileContentResponse(BaseModel):
    path: str
    content: str
    truncated: bool = False


class PreviewResponse(BaseModel):
    port: int
    url: str


async def _load(project_id: UUID, node_id: UUID, env_repo: EnvRepo) -> EnvNode:
    """The node, or 404. Also refuses a node from another project."""
    node = await to_thread.run_sync(env_repo.get_environment_node, str(node_id))
    if node is None or node.project_id != str(project_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Environment not found")
    return node


async def _load_ready(project_id: UUID, node_id: UUID, env_repo: EnvRepo) -> EnvNode:
    """A node with a live sandbox, or 409 naming the status it is actually in."""
    node = await _load(project_id, node_id, env_repo)
    if node.status != "ready" or not node.sandbox_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Environment is {node.status}. Start it first.",
        )
    return node


async def _sandbox_or_502(env_repo: EnvRepo, node: EnvNode) -> AsyncSandbox:
    """Connect, resuming a paused sandbox, or record the failure and 502.
        Ensure node errors this turn not the next.
    """
    ctx = EnvContext(
        node_id=node.id,
        project_id=node.project_id,
        name=node.name,
        config=node.config,
        status=node.status,
    )
    try:
        return await e2b.connect(ctx)
    except Exception as exc:
        detail = f"{type(exc).__name__}: {exc}"[:500]
        await to_thread.run_sync(lambda: env_repo.set_status(node.id, "error", detail))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Environment unreachable: {detail}",
        ) from exc


def _resolve(path: str) -> str:
    """
    Normalise a browsing path. Absolute paths are allowed on purpose.
    """
    if "\x00" in path:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid path")
    return posixpath.normpath(path)


# -- ROUTES ---------------------------------------------------------------

@router.get("/{node_id}", response_model=EnvironmentNodeResponse)
async def get_environment(
    project_id: UUID, node_id: UUID, env_repo: EnvRepo
) -> EnvironmentNodeResponse:
    """One environment box, with its lifecycle state."""
    return EnvironmentNodeResponse.of(await _load(project_id, node_id, env_repo))


@router.patch("/{node_id}", response_model=EnvironmentNodeResponse)
async def update_environment(
    project_id: UUID, node_id: UUID, req: UpdateEnvironmentRequest, env_repo: EnvRepo
) -> EnvironmentNodeResponse:
    """Rename, move, or change the approval policy. An empty body is a no-op."""
    await _load(project_id, node_id, env_repo)
    updated = await to_thread.run_sync(
        lambda: env_repo.update_environment_node(str(node_id), req.model_dump(exclude_none=True))
    )
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Environment not found")
    return EnvironmentNodeResponse.of(updated)


@router.post("/{node_id}/start", response_model=EnvironmentNodeResponse)
async def start_environment(
    project_id: UUID, node_id: UUID, env_repo: EnvRepo
) -> EnvironmentNodeResponse:
    """Provision the sandbox, restarting a stopped environment.

    force=True because a turn deliberately leaves a stopped node alone: only
    the user may pay to rebuild a filesystem they chose to destroy.

    Always 200. Provisioning can fail, and the client reads status and
    status_detail to find out; a failed create is not a failed request.
    """
    node = await _load(project_id, node_id, env_repo)
    result = await lifecycle.ensure_provisioned(env_repo, node, force=True)
    return EnvironmentNodeResponse.of(result)


@router.post("/{node_id}/stop", response_model=EnvironmentNodeResponse)
async def stop_environment(
    project_id: UUID, node_id: UUID, env_repo: EnvRepo
) -> EnvironmentNodeResponse:
    """Kill the sandbox. The filesystem is gone; a restart begins empty."""
    node = await _load(project_id, node_id, env_repo)
    if node.status == "provisioning":
        # The sandbox id is not written back yet, so killing now would leak it.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Environment is provisioning. Try again in a moment.",
        )
    return EnvironmentNodeResponse.of(await lifecycle.stop(env_repo, node))


@router.post("/{node_id}/verify", response_model=EnvironmentNodeResponse)
async def verify_environment(
    project_id: UUID, node_id: UUID, env_repo: EnvRepo
) -> EnvironmentNodeResponse:
    """Re-check that the sandbox is reachable and record the answer."""
    node = await _load(project_id, node_id, env_repo)
    return EnvironmentNodeResponse.of(await lifecycle.verify(env_repo, node))


_ENTRY_TYPES = {
    FileType.DIR: "dir",
    FileType.FILE: "file",
    FileType.SYMLINK: "symlink",
}


@router.get("/{node_id}/files", response_model=FileListResponse)
async def list_environment_files(
    project_id: UUID,
    node_id: UUID,
    env_repo: EnvRepo,
    path: str = Query(default=WORKSPACE_ROOT, max_length=4096),
) -> FileListResponse:
    """One directory, one level deep. The tree view walks it a level at a time."""
    node = await _load_ready(project_id, node_id, env_repo)
    resolved = _resolve(path)
    sandbox = await _sandbox_or_502(env_repo, node)
    try:
        entries = await sandbox.files.list(resolved, depth=1)
    except FileNotFoundException as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No such directory: {path}"
        ) from exc

    return FileListResponse(
        path=resolved,
        entries=[
            FileEntry(
                name=e.name,
                type=_ENTRY_TYPES.get(e.type, "file"),
                path=e.path,
                size=getattr(e, "size", 0) or 0,
            )
            for e in entries
        ],
    )


@router.get("/{node_id}/files/content", response_model=FileContentResponse)
async def read_environment_file(
    project_id: UUID,
    node_id: UUID,
    env_repo: EnvRepo,
    path: str = Query(min_length=1, max_length=4096),
) -> FileContentResponse:
    """One text file, capped. Binary is refused rather than mangled."""
    node = await _load_ready(project_id, node_id, env_repo)
    resolved = _resolve(path)
    sandbox = await _sandbox_or_502(env_repo, node)
    try:
        content = await sandbox.files.read(resolved)
    except FileNotFoundException as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No such file: {path}"
        ) from exc
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Binary file, cannot display as text: {path}",
        ) from exc

    cap = settings.environment_max_file_chars
    truncated = len(content) > cap
    return FileContentResponse(
        path=resolved, content=content[:cap] if truncated else content, truncated=truncated
    )


@router.get("/{node_id}/preview", response_model=PreviewResponse)
async def preview_environment_port(
    project_id: UUID,
    node_id: UUID,
    env_repo: EnvRepo,
    port: int = Query(ge=1, le=65535),
) -> PreviewResponse:
    """A public URL for whatever the agent is serving on that port.

    Connecting first is deliberate: it resumes a paused sandbox, so the link
    works rather than 502ing on the viewer's first request.
    """
    node = await _load_ready(project_id, node_id, env_repo)
    sandbox = await _sandbox_or_502(env_repo, node)
    return PreviewResponse(port=port, url=f"https://{sandbox.get_host(port)}")


# -- creation, called from the shared node endpoint ---------------------------


def _environment_config(config: dict[str, Any]) -> dict[str, Any]:
    """Validate the client's config and fill in what the backend owns.

    Unknown keys are rejected rather than ignored: silently dropping
    sandbox_id would let a caller think they had pointed at a sandbox.
    """
    unknown = set(config) - set(_CREATE_CONFIG_KEYS)
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown config field(s): {', '.join(sorted(unknown))}",
        )

    template = config.get("template") or settings.e2b_template
    if not isinstance(template, str) or not 1 <= len(template) <= 100:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="template must be a string of 1 to 100 characters",
        )

    idle = config.get("idle_timeout_s") or settings.environment_idle_timeout_s
    if not isinstance(idle, int) or isinstance(idle, bool) or not 60 <= idle <= 3600:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="idle_timeout_s must be an integer between 60 and 3600",
        )

    ports = config.get("preview_ports") or []
    if not isinstance(ports, list) or len(ports) > 10:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="preview_ports must be a list of at most 10 ports",
        )
    for port in ports:
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="preview_ports must contain integers between 1 and 65535",
            )

    description = config.get("description")
    if description is not None and (not isinstance(description, str) or len(description) > 500):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="description must be a string of at most 500 characters",
        )

    resolved: dict[str, Any] = {
        "runtime": "e2b",
        "role": "user",
        "sandbox_id": None,
        "template": template,
        "idle_timeout_s": idle,
        "preview_ports": ports,
    }
    if description:
        resolved["description"] = description
    return resolved


async def create_environment_node(
    project_id: UUID, req, env_repo: EnvRepo
) -> EnvironmentNodeResponse:
    """Provision an environment box. Called from POST /projects/{id}/nodes.

    Creates the row only. The sandbox comes from Start or the first turn that
    reaches it, so an unused environment costs nothing.
    """
    config = _environment_config(req.config)
    node_id = await to_thread.run_sync(
        lambda: env_repo.create_environment_node(
            str(project_id),
            req.name or "Environment",
            config,
            tool_policy="ask",
            position_x=req.position_x,
            position_y=req.position_y,
        )
    )
    node = await to_thread.run_sync(env_repo.get_environment_node, node_id)
    if node is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Environment could not be read back after creation",
        )
    return EnvironmentNodeResponse.of(node)
