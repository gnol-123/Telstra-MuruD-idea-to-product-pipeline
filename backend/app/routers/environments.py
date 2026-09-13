"""Environment nodes: the lifecycle endpoints.

Creation lives on POST /projects/{id}/nodes with kind='environment', beside
agents and tools, because the canvas creates all three the same way. Only
create_environment_node is exported for that; everything else is a route here.
"""

import asyncio
import json
import logging
import posixpath
from typing import Any, Literal
from uuid import UUID

import anyio
from anyio import to_thread
from e2b import AsyncSandbox, FileNotFoundException, FileType, PtySize
from fastapi import APIRouter, HTTPException, Query, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from app.config import settings
from app.environments import e2b, lifecycle
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
    handle = await sandbox.pty.create(size, output.put_nowait, cwd=WORKSPACE_ROOT, timeout=0)
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
