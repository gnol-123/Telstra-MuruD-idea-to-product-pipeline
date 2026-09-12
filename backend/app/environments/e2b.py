"""E2B: the remote sandbox runtime.

Control plane only. The agent facing toolset lives in build().

Two rules hold throughout. E2B calls are natively async, so they are awaited
directly and never wrapped in to_thread. And `async with AsyncSandbox...` is
never used: its __aexit__ kills the sandbox, so kill() appears only in
teardown and in the provision rollback.
"""

import logging

from e2b import AsyncSandbox, NotFoundException
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
    """The agent facing toolset. Filled in by the next task."""
    return FunctionToolset()
