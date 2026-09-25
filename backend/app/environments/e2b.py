"""E2B: the remote sandbox runtime.

Control plane only. The agent facing toolset lives in build().

Two rules hold throughout. E2B calls are natively async, so they are awaited
directly and never wrapped in to_thread. And `async with AsyncSandbox...` is
never used: its __aexit__ kills the sandbox, so kill() appears only in
teardown and in the provision rollback.
"""

import asyncio
import logging
import posixpath
from datetime import UTC, datetime

from e2b import (
    AsyncSandbox,
    CommandExitException,
    FileNotFoundException,
    FileType,
    NotFoundException,
    TimeoutException,
)
from pydantic_ai.toolsets import FunctionToolset

from app.config import settings
from app.environments.base import WORKSPACE_ROOT, EnvContext
from app.tools.base import VerifyResult

logger = logging.getLogger(__name__)

# status_detail is a text column and reaches the API, so cap what we write.
_MAX_DETAIL = 500


def _api() -> dict:
    """Credentials for a control plane call, from settings rather than the env."""
    return {"api_key": settings.e2b_api_key} if settings.e2b_api_key else {}


def _detail(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"[:_MAX_DETAIL]


async def provision(ctx: EnvContext) -> str:
    """Create the sandbox and its workspace root. Returns the sandbox id.

    on_timeout=pause is what makes a node lifetime sandbox affordable: an idle
    sandbox is snapshotted rather than killed, and resuming resets the
    continuous runtime window.
    """
    if not settings.e2b_api_key:
        raise RuntimeError("E2B_API_KEY is not configured")

    lifecycle: dict = {"on_timeout": "pause"}
    if settings.e2b_auto_resume:
        lifecycle["auto_resume"] = True

    sbx = await AsyncSandbox.create(
        template=ctx.template,
        timeout=ctx.idle_timeout_s,
        # Lets the sweep find sandboxes whose node row is gone.
        metadata={"app": "murud", "node_id": ctx.node_id, "project_id": ctx.project_id},
        lifecycle=lifecycle,
        **_api(),
    )
    try:
        await sbx.files.make_dir(WORKSPACE_ROOT)
    except Exception:
        # Do not leak a sandbox we could not finish setting up. A failure
        # here means it is orphaned, so say so: the sweep is the backstop.
        try:
            await sbx.kill()
        except Exception:
            logger.exception("failed to kill sandbox %s after setup error", sbx.sandbox_id)
        raise
    return sbx.sandbox_id


async def connect(ctx: EnvContext) -> AsyncSandbox:
    """Connect, resuming a paused sandbox, and push the deadline.

    The E2B timeout is wall clock from creation, not an idle timer, so every
    use has to extend it or a busy sandbox pauses mid turn.
    """
    if not ctx.sandbox_id:
        raise NotFoundException(f"environment {ctx.node_id} has no sandbox")
    sbx = await AsyncSandbox.connect(ctx.sandbox_id, **_api())
    await sbx.set_timeout(ctx.idle_timeout_s)
    return sbx


async def verify(ctx: EnvContext) -> VerifyResult:
    """Liveness of the recorded sandbox. Never raises."""
    if not ctx.sandbox_id:
        return VerifyResult(ok=False, detail="No sandbox. Start the environment.")
    try:
        sbx = await connect(ctx)
        running = await sbx.is_running()
    except NotFoundException:
        return VerifyResult(
            ok=False,
            detail="Sandbox not found. It may have been stopped. Start the environment again.",
        )
    except Exception as exc:
        return VerifyResult(ok=False, detail=_detail(exc))
    return VerifyResult(
        ok=running,
        detail="Sandbox running" if running else "Sandbox is not running",
    )


async def teardown(sandbox_id: str) -> None:
    """Kill the sandbox. Already gone is the desired end state, not an error."""
    try:
        await AsyncSandbox.kill(sandbox_id, **_api())
    except NotFoundException:
        pass


def build(ctx: EnvContext) -> FunctionToolset:
    """The agent facing toolset: one sandbox connection, shared and lazy.

    Every closure below returns a string and never raises. That is what keeps
    RecordingToolset recording 'ok' and lets the turn continue past a shell
    command that failed, a missing file, or a dead sandbox.
    """
    # Lazy: workspace imports this module.
    from app.environments import workspace

    state: dict = {"sbx": None, "dir_ready": False}
    lock = asyncio.Lock()
    max_out = settings.environment_max_output_chars
    max_file = settings.environment_max_file_chars

    def _clip(s: str, limit: int) -> str:
        if len(s) <= limit:
            return s
        return s[:limit] + f"\n...[truncated {len(s) - limit} chars]"

    def _resolve(path: str) -> str:
        if "\x00" in path:
            raise ValueError("invalid path")
        p = path if path.startswith("/") else posixpath.join(ctx.agent_dir, path)
        return posixpath.normpath(p)

    def _format(exit_code: int, stdout: str, stderr: str) -> str:
        return (
            f"exit_code: {exit_code}\n"
            f"stdout:\n{_clip(stdout, max_out)}\n"
            f"stderr:\n{_clip(stderr, max_out)}"
        )

    async def _unavailable(exc: Exception) -> str:
        state["sbx"] = None
        detail = _detail(exc)
        if ctx.set_status is not None:
            await ctx.set_status("error", detail)
        return f"Environment '{ctx.name}' is unavailable: {detail}"

    async def _sandbox() -> AsyncSandbox:
        async with lock:
            if state["sbx"] is None:
                state["sbx"] = await connect(ctx)
                if ctx.status == "error" and ctx.set_status is not None:
                    # Reachable again after a failure. Say so.
                    await ctx.set_status("ready", "Sandbox running")
            if not state["dir_ready"]:
                await state["sbx"].files.make_dir(ctx.agent_dir)
                state["dir_ready"] = True
            return state["sbx"]

    async def run_command(command: str, timeout_seconds: int | None = None) -> str:
        if timeout_seconds is not None and timeout_seconds < 0:
            # Flooring it would report a confusing 1s timeout instead.
            return "Invalid timeout_seconds: must be a positive number of seconds."

        try:
            sbx = await _sandbox()
        except Exception as exc:
            return await _unavailable(exc)

        # 0 reads as no preference, not as an instant timeout. The floor keeps a
        # fractional value from truncating to 0, which E2B reads as unlimited.
        t = max(1, min(int(timeout_seconds or settings.environment_command_timeout_s), 600))
        try:
            r = await sbx.commands.run(command, cwd=ctx.agent_dir, timeout=t)
            out = _format(r.exit_code, r.stdout, r.stderr)
        except CommandExitException as exc:
            # A non-zero exit is a result the model reads, not a failure.
            out = _format(exc.exit_code, exc.stdout, exc.stderr)
        except TimeoutException:
            out = (
                f"Command timed out after {t}s. Start long-running processes in "
                "the background with nohup ... &"
            )
        except Exception as exc:
            return f"Command failed: {type(exc).__name__}: {exc}"[:1000]

        try:
            # A long command must not let the sandbox pause mid-turn.
            await sbx.set_timeout(ctx.idle_timeout_s)
        except Exception:
            logger.warning("failed to extend timeout after run_command on %s", ctx.node_id)
        return out

    async def read_file(path: str) -> str:
        try:
            sbx = await _sandbox()
        except Exception as exc:
            return await _unavailable(exc)
        try:
            p = _resolve(path)
            return _clip(await sbx.files.read(p), max_file)
        except FileNotFoundException:
            return f"No such file: {path}"
        except UnicodeDecodeError:
            return f"Binary file, cannot display as text: {path}"
        except ValueError:
            return "Invalid path"
        except Exception as exc:
            return f"Read failed: {type(exc).__name__}: {exc}"[:1000]

    async def write_file(path: str, content: str) -> str:
        try:
            sbx = await _sandbox()
        except Exception as exc:
            return await _unavailable(exc)
        try:
            p = _resolve(path)
            await sbx.files.write(p, content)
            return f"Wrote {len(content.encode('utf-8'))} bytes to {p}"
        except ValueError:
            return "Invalid path"
        except Exception as exc:
            return f"Write failed: {type(exc).__name__}: {exc}"[:1000]

    async def list_files(path: str = ".") -> str:
        try:
            sbx = await _sandbox()
        except Exception as exc:
            return await _unavailable(exc)
        try:
            p = _resolve(path)
            entries = await sbx.files.list(p, depth=1)
        except FileNotFoundException:
            return f"No such directory: {path}"
        except ValueError:
            return "Invalid path"
        except Exception as exc:
            return f"List failed: {type(exc).__name__}: {exc}"[:1000]

        dirs = sorted(e.name for e in entries if e.type == FileType.DIR)
        files = sorted((e.name, e.size) for e in entries if e.type != FileType.DIR)
        lines = [f"{p}/"] + [f"  {d}/" for d in dirs] + [f"  {n}  {s} B" for n, s in files]
        return _clip("\n".join(lines), max_out)

    async def next_free_port() -> str:
        try:
            sbx = await _sandbox()
        except Exception as exc:
            return await _unavailable(exc)
        try:
            listening = await workspace.listening_ports(sbx)
        except Exception as exc:
            return f"Could not check ports: {type(exc).__name__}: {exc}"[:500]
        taken = {p.port for p in listening}
        port = workspace.next_free(workspace.AGENT_PORTS, taken)
        if port is None:
            return "No free port between 3000 and 3099."
        return str(port)

    async def publish_preview(title: str, port: int, path: str = "/") -> str:
        if not 1 <= port <= 65535 or port == workspace.ENVD_PORT:
            return f"Invalid port: {port}"
        title = " ".join((title or "").split())
        # The user sees the title, not the port. Reject lazy ones.
        lazy = title.lower().startswith(("port", "http", "localhost")) or title.isdigit()
        if len(title) < 3 or lazy:
            return (
                "Give a real title: 2 to 5 words naming what the user will see, "
                "like 'Todo app' or 'Pricing page prototype'. Not a port or a URL."
            )
        try:
            sbx = await _sandbox()
        except Exception as exc:
            return await _unavailable(exc)

        deadline = asyncio.get_running_loop().time() + 30.0
        while True:
            try:
                listening = await workspace.listening_ports(sbx)
                answering = await workspace.web_ports(sbx, [p for p in listening if p.port == port])
            except Exception as exc:
                return f"Could not check ports: {type(exc).__name__}: {exc}"[:500]
            if answering:
                break
            if asyncio.get_running_loop().time() >= deadline:
                return (
                    f"Port {port} is not answering HTTP after 30s. Start it in the "
                    f"background bound to 0.0.0.0, e.g. nohup ... --host 0.0.0.0 "
                    f"--port {port} > {workspace.sandbox_temp(f'murud-{port}.log')} 2>&1 & "
                    "then call publish_preview again."
                )
            await asyncio.sleep(1.5)

        entry = {
            "title": title,
            "port": port,
            "path": path or "/",
            "agent_node_id": ctx.agent_node_id,
            "created_at": datetime.now(UTC).isoformat(),
        }
        try:
            await workspace.upsert_preview(sbx, entry)
        except Exception as exc:
            return f"Could not record preview: {type(exc).__name__}: {exc}"[:500]

        url = f"https://{sbx.get_host(port)}"
        if path and path != "/":
            url = url.rstrip("/") + "/" + path.lstrip("/")
        return f"Preview published: {url}"

    ts = FunctionToolset()
    ts.add_function(
        run_command,
        name="run_command",
        description=(
            "Run a shell command in this environment. The working directory is your "
            "own directory inside it. Returns exit_code, stdout and stderr. Start "
            "servers in the background with nohup ... & bound to 0.0.0.0, then use "
            "next_free_port and publish_preview to show it to the user."
        ),
    )
    ts.add_function(
        next_free_port,
        name="next_free_port",
        description=(
            "Get a free port for a server you are about to start, in the range "
            "3000-3099. Call this before starting a dev server."
        ),
    )
    ts.add_function(
        publish_preview,
        name="publish_preview",
        description=(
            "Publish a running server so the user sees it as a live preview beside "
            "the chat. title is what the user sees in the preview list: 2 to 5 "
            "words naming the thing, like 'Todo app' or 'Pricing page prototype', "
            "never a port or URL. Waits up to 30s for the port to answer HTTP. Call "
            "this after starting a server in the background, not before."
        ),
    )
    ts.add_function(
        read_file,
        name="read_file",
        description=(
            "Read a text file. Relative paths resolve against your directory; "
            "absolute paths are allowed."
        ),
    )
    ts.add_function(
        write_file,
        name="write_file",
        description=(
            "Write a text file, creating parent directories. Overwrites. Relative "
            "paths resolve against your directory."
        ),
    )
    ts.add_function(
        list_files,
        name="list_files",
        description="List a directory (default: your directory). Directories end with /.",
    )
    return ts
