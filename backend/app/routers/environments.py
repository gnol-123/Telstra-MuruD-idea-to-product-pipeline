"""Environment nodes: the lifecycle endpoints.

Creation lives on POST /projects/{id}/nodes with kind='environment', beside
agents and tools, because the canvas creates all three the same way. Only
create_environment_node is exported for that; everything else is a route here.
"""

import asyncio
import json
import logging
import posixpath
import uuid as uuid_lib
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal, TypeVar
from uuid import UUID

import anyio
from anyio import to_thread
from e2b import (
    AsyncSandbox,
    CommandExitException,
    FileNotFoundException,
    FileType,
    PtySize,
)
from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, status
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from app.config import settings
from app.environments import e2b, lifecycle, workspace
from app.environments.base import WORKSPACE_ROOT, EnvContext
from app.repositories.environment_repo import EnvironmentRepository, EnvNode
from app.routers.auth import get_current_user
from app.routers.deps import EnvRepo
from app.services.supabase import get_user_client

logger = logging.getLogger(__name__)

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
    # ISO 8601. The tree shows it on hover; absent from older E2B envd.
    modified: str | None = None
    symlink_target: str | None = None


class FileListResponse(BaseModel):
    path: str
    entries: list[FileEntry]


class ListManyRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=20)


class DirListing(BaseModel):
    path: str
    entries: list[FileEntry] | None = None
    # Set instead of entries when this one directory could not be read.
    error: str | None = None


class ListManyResponse(BaseModel):
    listings: list[DirListing]


class FileContentResponse(BaseModel):
    path: str
    content: str
    truncated: bool = False


class FileWriteResponse(BaseModel):
    path: str
    size: int


class PreviewResponse(BaseModel):
    port: int
    url: str


class PortInfo(BaseModel):
    port: int
    url: str
    pid: int | None = None
    # A short label for the tab: 'python3 -m http.server', 'node server.js'.
    process: str = ""
    command: str = ""
    # Listening on loopback only. Usually still previewable through E2B, but
    # the first thing to check when it is not.
    local_only: bool = False
    # Set when this is a static server; the directory it serves.
    serving: str | None = None


class PortsResponse(BaseModel):
    ports: list[PortInfo]


class PreviewInfo(BaseModel):
    id: str
    title: str | None = None
    port: int
    path: str = "/"
    url: str
    live: bool
    published: bool
    agent_node_id: str | None = None
    created_at: str | None = None


class PreviewsResponse(BaseModel):
    previews: list[PreviewInfo]


class ServeRequest(BaseModel):
    # A directory to serve, or a file whose directory to serve. Absolute, or
    # relative to the workspace root.
    path: str = Field(default=WORKSPACE_ROOT, min_length=1, max_length=4096)


class ServeResponse(PortInfo):
    # True when a server on this directory was already running and reused.
    reused: bool = False
    # Where to point the preview: the port's URL plus the file, if one was
    # asked for.
    open_url: str


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


T = TypeVar("T")


def _ctx(node: EnvNode) -> EnvContext:
    return EnvContext(
        node_id=node.id,
        project_id=node.project_id,
        name=node.name,
        config=node.config,
        status=node.status,
    )


async def _mark_unreachable(env_repo: EnvRepo, node: EnvNode, detail: str) -> HTTPException:
    """Record the failure so the canvas reflects it now, not on the next turn."""
    await to_thread.run_sync(lambda: env_repo.set_status(node.id, "error", detail))
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"Environment unreachable: {detail}",
    )


async def _sandbox_or_502(env_repo: EnvRepo, node: EnvNode) -> AsyncSandbox:
    """Connect (reusing a recent connection), or record the failure and 502."""
    try:
        return await workspace.connected(_ctx(node))
    except workspace.Unreachable as exc:
        raise await _mark_unreachable(env_repo, node, str(exc)) from exc


async def _on_sandbox(
    env_repo: EnvRepo, node: EnvNode, op: Callable[[AsyncSandbox], Awaitable[T]]
) -> T:
    """Run one browsing call on a held connection.

    Semantic errors (a missing file, a binary read as text) reach the route
    to be mapped. A connect failure marks the node and 502s. Anything else,
    after the one retry on a fresh connection, is a 502 that leaves the node
    alone: a slow command is not a broken environment.
    """
    try:
        return await workspace.with_sandbox(_ctx(node), op, passthrough=(HTTPException,))
    except workspace.Unreachable as exc:
        raise await _mark_unreachable(env_repo, node, str(exc)) from exc
    except (HTTPException, FileNotFoundException, UnicodeDecodeError, CommandExitException):
        raise
    except Exception as exc:
        logger.warning("environment call failed on %s: %s", node.id, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Environment call failed: {type(exc).__name__}: {exc}"[:500],
        ) from exc


def _resolve(path: str) -> str:
    """
    Normalise a browsing path. Absolute paths are allowed on purpose: the
    sandbox is the caller's own machine. A relative path is taken against
    the workspace root, which is what the tree shows.
    """
    if "\x00" in path:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid path")
    if not path.startswith("/"):
        path = posixpath.join(WORKSPACE_ROOT, path)
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
    # A held browsing connection would outlive the sandbox it points at.
    workspace.forget(node.sandbox_id)
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


def _entry(e: Any) -> FileEntry:
    modified = getattr(e, "modified_time", None)
    return FileEntry(
        name=e.name,
        type=_ENTRY_TYPES.get(e.type, "file"),
        path=e.path,
        size=getattr(e, "size", 0) or 0,
        modified=modified.isoformat() if modified is not None else None,
        symlink_target=getattr(e, "symlink_target", None) or None,
    )


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
    try:
        entries = await _on_sandbox(
            env_repo, node, lambda s: s.files.list(resolved, depth=1, user="user")
        )
    except FileNotFoundException as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No such directory: {path}"
        ) from exc

    return FileListResponse(path=resolved, entries=[_entry(e) for e in entries])


@router.post("/{node_id}/files/list", response_model=ListManyResponse)
async def list_many_environment_files(
    project_id: UUID, node_id: UUID, req: ListManyRequest, env_repo: EnvRepo
) -> ListManyResponse:
    """Several directories in one request, for the code preview's live refresh.

    The tree re-reads every open folder every few seconds; one request per
    folder would pay the ownership check and a fresh database client each
    time. A folder that fails (deleted by an agent since) reports its own
    error rather than failing the batch.
    """
    node = await _load_ready(project_id, node_id, env_repo)
    resolved = [_resolve(p) for p in req.paths]

    async def one(sandbox: AsyncSandbox, path: str) -> DirListing:
        try:
            entries = await sandbox.files.list(path, depth=1, user="user")
        except FileNotFoundException:
            return DirListing(path=path, error=f"No such directory: {path}")
        return DirListing(path=path, entries=[_entry(e) for e in entries])

    async def all_of(sandbox: AsyncSandbox) -> list[DirListing]:
        return list(await asyncio.gather(*(one(sandbox, p) for p in resolved)))

    return ListManyResponse(listings=await _on_sandbox(env_repo, node, all_of))


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
    try:
        content = await _on_sandbox(env_repo, node, lambda s: s.files.read(resolved, user="user"))
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


async def _stream(sandbox: AsyncSandbox, path: str, *, remove_after: bool) -> AsyncIterator[bytes]:
    """Relay a file from the sandbox without holding it in memory here.

    ``remove_after`` is for temp archives: deleted once sent, or once the
    client gives up, so an abandoned download does not fill /tmp.
    """
    try:
        async with await sandbox.files.read(path, format="stream", user="user") as stream:
            async for chunk in stream:
                yield bytes(chunk)
    finally:
        if remove_after:
            try:
                await sandbox.files.remove(path, user="user")
            except Exception:
                logger.warning("failed to remove temp archive %s", path)


@router.get("/{node_id}/files/download")
async def download_environment_file(
    project_id: UUID,
    node_id: UUID,
    env_repo: EnvRepo,
    path: str = Query(min_length=1, max_length=4096),
) -> StreamingResponse:
    """One file, any type, as a download. The code preview's save button.

    Streamed, not buffered: an agent's build output can be large, and this
    process should not hold it. A directory is 422 pointing at /archive.
    """
    node = await _load_ready(project_id, node_id, env_repo)
    resolved = _resolve(path)
    try:
        info = await _on_sandbox(env_repo, node, lambda s: s.files.get_info(resolved, user="user"))
    except FileNotFoundException as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No such file: {path}"
        ) from exc
    if info.type == FileType.DIR:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="That is a directory. Download it with /files/archive.",
        )

    sandbox = await _sandbox_or_502(env_repo, node)
    headers = {"Content-Disposition": workspace.content_disposition(posixpath.basename(resolved))}
    if getattr(info, "size", None):
        headers["Content-Length"] = str(info.size)
    return StreamingResponse(
        _stream(sandbox, resolved, remove_after=False),
        media_type=workspace.content_type_for(resolved),
        headers=headers,
    )


@router.get("/{node_id}/files/archive")
async def archive_environment_directory(
    project_id: UUID,
    node_id: UUID,
    env_repo: EnvRepo,
    path: str = Query(default=WORKSPACE_ROOT, min_length=1, max_length=4096),
    include_dependencies: bool = Query(default=False),
) -> StreamingResponse:
    """A directory as a .zip, built inside the sandbox and streamed out.

    Dependency and VCS folders (node_modules, .git, .venv, ...) are left out
    unless ``include_dependencies``: they are rebuilt from a lockfile and
    would otherwise be most of every download.
    """
    node = await _load_ready(project_id, node_id, env_repo)
    resolved = _resolve(path)
    out = workspace.sandbox_temp(f"murud-archive-{uuid_lib.uuid4().hex}.zip")
    command = workspace.archive_command(resolved, out, skip_heavy=not include_dependencies)

    async def build(sandbox: AsyncSandbox) -> tuple[int, int]:
        info = await sandbox.files.get_info(resolved, user="user")
        if info.type != FileType.DIR:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="That is a file. Download it with /files/download.",
            )
        result = await sandbox.commands.run(command, timeout=120, user="user")
        return workspace.parse_archive_output(result.stdout)

    try:
        size, _count = await _on_sandbox(env_repo, node, build)
    except FileNotFoundException as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No such directory: {path}"
        ) from exc
    except CommandExitException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not build the archive: {(exc.stderr or exc.stdout)[-300:]}",
        ) from exc

    sandbox = await _sandbox_or_502(env_repo, node)
    if size > settings.environment_max_archive_bytes:
        await _remove_quietly(sandbox, out)
        cap_mb = settings.environment_max_archive_bytes // 1_000_000
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"The archive is {size // 1_000_000} MB, over the {cap_mb} MB limit. "
            "Download a smaller folder.",
        )

    return StreamingResponse(
        _stream(sandbox, out, remove_after=True),
        media_type="application/zip",
        headers={
            "Content-Disposition": workspace.content_disposition(workspace.archive_name(resolved)),
            "Content-Length": str(size),
        },
    )


async def _remove_quietly(sandbox: AsyncSandbox, path: str) -> None:
    try:
        await sandbox.files.remove(path, user="user")
    except Exception:
        logger.warning("failed to remove %s", path)


@router.put("/{node_id}/files", response_model=FileWriteResponse)
async def write_environment_file(
    project_id: UUID,
    node_id: UUID,
    request: Request,
    env_repo: EnvRepo,
    path: str = Query(min_length=1, max_length=4096),
) -> FileWriteResponse:
    """Write one file from the raw request body. Upload and save both use it.

    Raw bytes rather than multipart, so any file type round-trips untouched
    and no form parser is needed. Parent directories are created. Overwrites.
    """
    node = await _load_ready(project_id, node_id, env_repo)
    resolved = _resolve(path)
    if resolved.endswith("/") or posixpath.basename(resolved) in ("", ".", ".."):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid path")

    cap = settings.environment_max_upload_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > cap:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Files are limited to {cap // 1_000_000} MB.",
        )
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > cap:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Files are limited to {cap // 1_000_000} MB.",
            )

    data = bytes(body)
    await _on_sandbox(env_repo, node, lambda s: s.files.write(resolved, data, user="user"))
    return FileWriteResponse(path=resolved, size=len(data))


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


@router.get("/{node_id}/ports", response_model=PortsResponse)
async def list_environment_ports(
    project_id: UUID, node_id: UUID, env_repo: EnvRepo
) -> PortsResponse:
    """Every port something is listening on, each with its preview URL.

    What lets the preview find a running app without anyone typing a port:
    an agent that started a dev server on 5173 shows up here unprompted.
    """
    node = await _load_ready(project_id, node_id, env_repo)

    async def scan(sandbox: AsyncSandbox) -> list[dict[str, Any]]:
        ports = await workspace.listening_ports(sandbox)
        return [workspace.port_payload(sandbox, p) for p in ports]

    try:
        payloads = await _on_sandbox(env_repo, node, scan)
    except CommandExitException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not list ports: {(exc.stderr or '')[-300:]}",
        ) from exc
    return PortsResponse(ports=[PortInfo(**p) for p in payloads])


@router.get("/{node_id}/previews", response_model=PreviewsResponse)
async def list_environment_previews(
    project_id: UUID, node_id: UUID, env_repo: EnvRepo
) -> PreviewsResponse:
    """Published previews first (newest first), then any other listening port.

    Mirrors /ports but merges in the agent-published registry, so a preview
    an agent named shows its title instead of just a bare port.
    """
    node = await _load_ready(project_id, node_id, env_repo)

    async def scan(sandbox: AsyncSandbox) -> list[dict[str, Any]]:
        registry = await workspace.read_registry(sandbox)
        # Live means answers HTTP, not just listening (ssh, rpcbind).
        listening = await workspace.web_ports(sandbox, await workspace.listening_ports(sandbox))
        return workspace.merge_previews(
            registry, listening, lambda port: f"https://{sandbox.get_host(port)}"
        )

    try:
        rows = await _on_sandbox(env_repo, node, scan)
    except CommandExitException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not list previews: {(exc.stderr or '')[-300:]}",
        ) from exc
    return PreviewsResponse(previews=[PreviewInfo(**r) for r in rows])


# How long /serve waits for a new server to start listening before answering
# anyway. python3 -m http.server is up in well under a second.
_SERVE_WAIT_SECONDS = 5.0


@router.post("/{node_id}/serve", response_model=ServeResponse)
async def serve_environment_directory(
    project_id: UUID, node_id: UUID, req: ServeRequest, env_repo: EnvRepo
) -> ServeResponse:
    """Start a static file server on a directory, or reuse the one running.

    The code preview's "Preview" on an .html file: agents' prototypes are
    plain files, and this shows one without a turn spent asking the agent to
    serve it. Given a file, serves its directory and returns a URL to it.
    """
    node = await _load_ready(project_id, node_id, env_repo)
    resolved = _resolve(req.path)

    async def serve(sandbox: AsyncSandbox) -> dict[str, Any]:
        info = await sandbox.files.get_info(resolved, user="user")
        directory = resolved if info.type == FileType.DIR else posixpath.dirname(resolved)
        file_part = "" if info.type == FileType.DIR else posixpath.basename(resolved)

        ports = await workspace.listening_ports(sandbox)
        try:
            port, reused = workspace.pick_serve_port(ports, directory)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

        if not reused:
            await sandbox.commands.run(
                workspace.serve_command(directory, port), timeout=15, user="user"
            )
            deadline = asyncio.get_running_loop().time() + _SERVE_WAIT_SECONDS
            while asyncio.get_running_loop().time() < deadline:
                ports = await workspace.listening_ports(sandbox)
                if any(p.port == port for p in ports):
                    break
                await asyncio.sleep(0.4)

        listening = next(
            (p for p in ports if p.port == port),
            workspace.ListeningPort(
                port=port,
                pid=None,
                command=f"python3 -m http.server {port} --directory {directory}",
                local_only=False,
            ),
        )
        payload = workspace.port_payload(sandbox, listening)
        payload["reused"] = reused
        payload["open_url"] = payload["url"] + "/" + file_part if file_part else payload["url"]
        return payload

    try:
        payload = await _on_sandbox(env_repo, node, serve)
    except FileNotFoundException as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"No such path: {req.path}"
        ) from exc
    except CommandExitException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not start a server: {(exc.stderr or '')[-300:]}",
        ) from exc
    return ServeResponse(**payload)


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


# -- terminal ----------------------------------------------------------------

# Close codes. The 4000-4999 range is reserved for applications, so these
# cannot collide with the protocol's own.
_WS_UNAUTHENTICATED = 4401
_WS_INSECURE = 4403
_WS_NOT_FOUND = 4404
_WS_NOT_READY = 4409
_WS_UNREACHABLE = 4502

# A hostile or buggy client must not ask for an enormous PTY.
_MIN_COLS, _MAX_COLS, _DEFAULT_COLS = 10, 500, 80
_MIN_ROWS, _MAX_ROWS, _DEFAULT_ROWS = 5, 200, 24

# How often to tell E2B the sandbox is still wanted. An open terminal is not
# activity as far as the deadline is concerned.
_KEEPALIVE_SECONDS = 60


def _terminal_repo(token: str, user_id: str) -> EnvironmentRepository:
    """A repository scoped to the socket's own token and caller.

    A WebSocket cannot use the HTTP dependency, so the caller is resolved from
    the query string and the repository built by hand. The user id is not
    optional: every query filters on owner_id, so a placeholder would match no
    rows and every terminal would report the environment missing.
    """
    return EnvironmentRepository(get_user_client(token), user_id)


def _clamp(value: int | None, low: int, high: int, default: int) -> int:
    if value is None:
        return default
    return max(low, min(value, high))


@router.websocket("/{node_id}/terminal")
async def environment_terminal(
    websocket: WebSocket,
    project_id: UUID,
    node_id: UUID,
    token: str | None = Query(default=None),
    cols: int | None = Query(default=None),
    rows: int | None = Query(default=None),
) -> None:
    """A shell in the browser, streamed both ways.

    Accept first, then validate: a rejection before the handshake gives the
    client an opaque failure, where a close after it carries a code they can
    act on. Nothing is read from the socket before the token is checked.
    """
    await websocket.accept()

    # A token in a query string is only safe over TLS. localhost is exempt so
    # development works without certificates.
    proto = websocket.headers.get("x-forwarded-proto", websocket.url.scheme)
    hostname = websocket.url.hostname or ""
    if proto not in ("wss", "https") and hostname not in (
        "localhost",
        "127.0.0.1",
        "testserver",
    ):
        await websocket.close(code=_WS_INSECURE, reason="wss required")
        return

    if not token:
        await websocket.close(code=_WS_UNAUTHENTICATED, reason="Not authenticated")
        return

    try:
        user = await get_current_user(
            HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        )
    except HTTPException:
        # get_current_user raises an HTTPException, which means nothing to a
        # WebSocket. Translate it into a code the client can read.
        await websocket.close(code=_WS_UNAUTHENTICATED, reason="Invalid or expired token")
        return

    env_repo = _terminal_repo(token, user.id)
    node = await to_thread.run_sync(env_repo.get_environment_node, str(node_id))
    if node is None or node.project_id != str(project_id):
        await websocket.close(code=_WS_NOT_FOUND, reason="Environment not found")
        return
    if node.status != "ready" or not node.sandbox_id:
        await websocket.close(code=_WS_NOT_READY, reason=f"Environment is {node.status}")
        return

    ctx = EnvContext(
        node_id=node.id,
        project_id=node.project_id,
        name=node.name,
        config=node.config,
        status=node.status,
    )
    try:
        sandbox = await e2b.connect(ctx)
    except Exception as exc:
        detail = f"{type(exc).__name__}: {exc}"[:500]
        await to_thread.run_sync(lambda: env_repo.set_status(node.id, "error", detail))
        await websocket.close(code=_WS_UNREACHABLE, reason="Environment unreachable")
        return

    size = PtySize(
        rows=_clamp(rows, _MIN_ROWS, _MAX_ROWS, _DEFAULT_ROWS),
        cols=_clamp(cols, _MIN_COLS, _MAX_COLS, _DEFAULT_COLS),
    )
    # Output arrives on E2B's own read loop, so the callback stays sync and
    # only hands the bytes to a queue this side drains.
    output: asyncio.Queue[bytes] = asyncio.Queue()
    handle = await sandbox.pty.create(
        size, output.put_nowait, cwd=WORKSPACE_ROOT, timeout=0, user="user"
    )
    pid = handle.pid

    try:
        await _run_terminal(websocket, sandbox, handle, pid, output, ctx)
    finally:
        # A PTY is a process inside the sandbox: closing the socket does not
        # stop it, and every reconnect would leave another shell behind.
        try:
            await sandbox.pty.kill(pid)
        except Exception:
            logger.warning("failed to kill pty %s on %s", pid, ctx.node_id)
        with anyio.move_on_after(1):
            try:
                await websocket.close()
            except Exception:
                # Already closed or half gone. Nothing left to do about it.
                logger.debug("terminal socket for %s was already closed", ctx.node_id)


async def _run_terminal(websocket, sandbox, handle, pid, output, ctx) -> None:
    """Four jobs at once; the session ends when any one of them finishes.

    A task group rather than asyncio.wait: cancelling the scope tears the
    others down deterministically, and the block does not exit until they have
    actually stopped. That ordering is what keeps the PTY kill reliable.
    """

    async def pump_output() -> None:
        while True:
            await websocket.send_bytes(await output.get())

    async def pump_input() -> None:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            if (data := message.get("bytes")) is not None:
                if data:
                    await sandbox.pty.send_stdin(pid, data)
                continue
            text = message.get("text")
            if not text:
                continue
            try:
                frame = json.loads(text)
            except (ValueError, TypeError):
                # Garbage from the client is ignored, never fatal.
                continue
            if not isinstance(frame, dict):
                continue
            kind = frame.get("type")
            if kind == "input":
                payload = frame.get("data") or ""
                if payload:
                    await sandbox.pty.send_stdin(pid, payload.encode())
            elif kind == "resize":
                await sandbox.pty.resize(
                    pid,
                    PtySize(
                        rows=_clamp(frame.get("rows"), _MIN_ROWS, _MAX_ROWS, _DEFAULT_ROWS),
                        cols=_clamp(frame.get("cols"), _MIN_COLS, _MAX_COLS, _DEFAULT_COLS),
                    ),
                )

    async def keepalive() -> None:
        while True:
            await asyncio.sleep(_KEEPALIVE_SECONDS)
            try:
                await sandbox.set_timeout(ctx.idle_timeout_s)
            except Exception:
                logger.warning("failed to extend timeout for terminal on %s", ctx.node_id)

    async def watch_exit() -> None:
        try:
            result = await handle.wait()
            code = getattr(result, "exit_code", 0)
        except Exception as exc:
            code = getattr(exc, "exit_code", 1)
        try:
            await websocket.send_text(json.dumps({"type": "exit", "code": code}))
        except Exception:
            # The client hung up first, which is the common case.
            logger.debug("could not send exit frame for %s", ctx.node_id)

    async with anyio.create_task_group() as tg:

        async def run(job) -> None:
            try:
                await job()
            finally:
                # First one home ends the session for everyone.
                tg.cancel_scope.cancel()

        tg.start_soon(run, pump_output)
        tg.start_soon(run, pump_input)
        tg.start_soon(run, keepalive)
        tg.start_soon(run, watch_exit)
