"""Shared types for the environment registry.

Mirrors app/tools/base.py. An environment differs from a tool in lifecycle,
not in how an agent reaches it: it is provisioned once and torn down later,
where a tool is built fresh each turn.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic_ai.toolsets import AbstractToolset

from app.config import settings
from app.tools.base import VerifyResult

# Every agent works in its own subdirectory of this. A convention, not a
# boundary: a shell can cd out of it, which is what lets one agent read
# another's output.
WORKSPACE_ROOT = "/home/user/workspace"

# Writes a node's status without the caller holding a repository.
StatusWriter = Callable[[str, str | None], Awaitable[None]]


@dataclass(frozen=True)
class EnvContext:
    """One environment node, ready to act on."""

    node_id: str
    project_id: str
    name: str
    config: dict[str, Any]
    status: str
    # Set inside a turn. None for verify, provision and the browsing endpoints.
    agent_node_id: str | None = None
    # Injected by assembly so a tool can flip status without a repository.
    set_status: StatusWriter | None = None

    @property
    def sandbox_id(self) -> str | None:
        # Cleared as null, but tolerate '' either way.
        return self.config.get("sandbox_id") or None

    @property
    def idle_timeout_s(self) -> int:
        return int(self.config.get("idle_timeout_s") or settings.environment_idle_timeout_s)

    @property
    def template(self) -> str:
        return str(self.config.get("template") or settings.e2b_template)

    @property
    def agent_dir(self) -> str:
        """Where this agent works. The root when there is no agent."""
        return f"{WORKSPACE_ROOT}/{self.agent_node_id}" if self.agent_node_id else WORKSPACE_ROOT


@dataclass(frozen=True)
class EnvSpec:
    """One runtime's implementation. Keyed on config.runtime, never on role."""

    runtime: str
    # Creates the sandbox and its workspace root. Returns the sandbox id.
    # May drop config keys it could not honour; lifecycle persists ctx.config.
    provision: Callable[[EnvContext], Awaitable[str]]
    # Sync, never raises. The connection is made lazily on first tool call.
    build: Callable[[EnvContext], AbstractToolset]
    # Can we reach sandbox_id right now.
    verify: Callable[[EnvContext], Awaitable[VerifyResult]]
    # Kill the sandbox. Safe when it is already gone.
    teardown: Callable[[str], Awaitable[None]]
