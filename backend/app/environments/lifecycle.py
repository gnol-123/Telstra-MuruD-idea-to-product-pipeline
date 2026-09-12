"""The environment state machine.

Every function is idempotent and returns the node as it stands afterwards, so
a caller reads .status rather than trusting a return code. Repository calls go
through to_thread because the Supabase client is sync; E2B calls are natively
async and are awaited directly.
"""

import logging

from anyio import to_thread

from app.environments.base import EnvContext
from app.environments.registry import get_spec
from app.repositories.environment_repo import EnvNode

logger = logging.getLogger(__name__)

# status_detail is a text column and reaches the API, so cap what we write.
_MAX_DETAIL = 500


def _detail(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"[:_MAX_DETAIL]


def _ctx(node: EnvNode) -> EnvContext:
    """A context with no agent: lifecycle work is not part of a turn."""
    return EnvContext(
        node_id=node.id,
        project_id=node.project_id,
        name=node.name,
        config=node.config,
        status=node.status,
    )


async def _set(env_repo, node_id: str, status: str, detail: str | None) -> None:
    await to_thread.run_sync(lambda: env_repo.set_status(node_id, status, detail))


async def _reload(env_repo, node_id: str) -> EnvNode | None:
    return await to_thread.run_sync(lambda: env_repo.get_environment_node(node_id))


async def ensure_provisioned(env_repo, node: EnvNode, *, force: bool = False) -> EnvNode:
    """Bring a node to ready if it is not already. Safe to call concurrently.

    Returns the node as it stands afterwards. A caller must check .status:
    losing the provisioning race, or a failed create, both come back as a node
    that is not ready rather than as an exception.

    ``force`` restarts a stopped node. A turn never sets it: stopping destroys
    the filesystem, so rebuilding is the user's call, made from the canvas.
    """
    if node.status == "ready" and node.sandbox_id:
        return node
    # Another caller is mid-provision.
    if node.status == "provisioning":
        return node
    if node.status == "stopped" and not force:
        return node

    spec = get_spec(node.runtime)
    if spec is None:
        await _set(env_repo, node.id, "error", f"Unknown runtime '{node.runtime}'")
        return await _reload(env_repo, node.id) or node

    ctx = _ctx(node)

    # An errored node may still have a live sandbox. Reconnecting beats paying
    # for a new one and losing the filesystem.
    if node.status == "error" and node.sandbox_id:
        result = await spec.verify(ctx)
        if result.ok:
            await _set(env_repo, node.id, "ready", result.detail)
            return await _reload(env_repo, node.id) or node
        try:
            await spec.teardown(node.sandbox_id)
        except Exception:
            # Cannot reach it to kill it. The sweep is the backstop; do not
            # let that block making a working sandbox.
            logger.warning("failed to tear down dead sandbox %s", node.sandbox_id)

    won = await to_thread.run_sync(lambda: env_repo.try_begin_provisioning(node.id))
    if not won:
        # Another caller claimed it. Report whatever they left it as.
        return await _reload(env_repo, node.id) or node

    try:
        sandbox_id = await spec.provision(ctx)
    except Exception as exc:
        await _set(env_repo, node.id, "error", _detail(exc))
        return await _reload(env_repo, node.id) or node

    # The id lands before the status, so nothing sees ready without a sandbox.
    await to_thread.run_sync(
        lambda: env_repo.set_config(node.id, {**node.config, "sandbox_id": sandbox_id})
    )
    await _set(env_repo, node.id, "ready", "Sandbox running")
    return await _reload(env_repo, node.id) or node


async def stop(env_repo, node: EnvNode) -> EnvNode:
    """Kill the sandbox and mark the node stopped. The filesystem is gone.

    Status is written before the id is cleared. The two writes cannot be
    atomic, and a stopped node with a stale id is harmless, where a ready node
    with no id would fail confusingly on the next turn.
    """
    spec = get_spec(node.runtime)
    if spec is not None and node.sandbox_id:
        try:
            await spec.teardown(node.sandbox_id)
        except Exception:
            # The user asked to stop. Record it even if E2B is unreachable.
            logger.warning("failed to kill sandbox %s on stop", node.sandbox_id)

    await _set(env_repo, node.id, "stopped", "Stopped by user")
    await to_thread.run_sync(
        lambda: env_repo.set_config(node.id, {**node.config, "sandbox_id": None})
    )
    return await _reload(env_repo, node.id) or node


async def teardown(env_repo, node: EnvNode) -> None:
    """Kill the sandbox before the row is deleted. Never raises.

    No status write: the row is about to disappear.
    """
    spec = get_spec(node.runtime)
    if spec is None or not node.sandbox_id:
        return
    try:
        await spec.teardown(node.sandbox_id)
    except Exception:
        # A delete must not fail because E2B is down. The sweep is the backstop.
        logger.warning("failed to kill sandbox %s on delete", node.sandbox_id)


async def verify(env_repo, node: EnvNode) -> EnvNode:
    """Check the sandbox is reachable and record the answer."""
    if node.status == "stopped":
        # Having no sandbox is correct here, not a fault. Writing 'error'
        # would erase the state ensure_provisioned checks, and the next turn
        # would pay for a sandbox the user deliberately stopped.
        return node

    if node.status == "provisioning" and not node.sandbox_id:
        # A restart mid-provision strands a node here. This is the way out.
        await _set(
            env_repo,
            node.id,
            "error",
            "Provisioning did not complete. Start the environment again.",
        )
        return await _reload(env_repo, node.id) or node

    spec = get_spec(node.runtime)
    if spec is None:
        await _set(env_repo, node.id, "error", f"Unknown runtime '{node.runtime}'")
    else:
        result = await spec.verify(_ctx(node))
        await _set(env_repo, node.id, "ready" if result.ok else "error", result.detail)
    return await _reload(env_repo, node.id) or node
