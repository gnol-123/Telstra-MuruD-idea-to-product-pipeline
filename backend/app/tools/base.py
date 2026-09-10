"""Shared types for the tool registry."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic_ai.toolsets import AbstractToolset


@dataclass(frozen=True)
class ToolContext:
    """One configured tool node, ready to build a toolset from."""

    node_id: str
    name: str
    config: dict[str, Any]
    # Decrypted. Not logged, not stored in DBOS, not sent to the frontend.
    secrets: dict[str, str]


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    detail: str | None = None
    # MCP servers report their tools at connect time, so a client can list them.
    discovered_tools: list[str] | None = None


@dataclass(frozen=True)
class ToolSpec:
    #
    kind: Literal["api", "mcp", "skill"]
    build: Callable[[ToolContext], AbstractToolset]
    verify: Callable[[ToolContext], Awaitable[VerifyResult]]
