"""Environment nodes: the boxes an agent executes inside.

Mirrors ToolRepository. Every query filters on owner and on kind, because one
nodes table holds three kinds and the other two repositories filter to theirs.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from postgrest.exceptions import APIError

from app.config import settings

_ENV_COLUMNS = (
    "id, project_id, name, config, status, status_detail, tool_policy, position_x, position_y"
)

_UNIQUE_VIOLATION = "23505"

# Statuses a provisioning attempt may claim. Never 'ready' or 'provisioning'.
_CLAIMABLE = ["pending", "error", "stopped"]


@dataclass(frozen=True)
class EnvNode:
    """Configurations for each individual environment node."""

    id: str
    project_id: str
    name: str
    config: dict[str, Any]
    status: str
    status_detail: str | None
    tool_policy: str
    position_x: float
    position_y: float

    @property
    def runtime(self) -> str:
        return str(self.config.get("runtime") or "e2b")

    @property
    def role(self) -> str:
        return str(self.config.get("role") or "user")

    @property
    def sandbox_id(self) -> str | None:
        # Cleared as null, but tolerate '' so a stopped node reads the same either way.
        return self.config.get("sandbox_id") or None


def _to_env_node(row: dict[str, Any]) -> EnvNode:
    return EnvNode(
        id=row["id"],
        project_id=row["project_id"],
        name=row["name"],
        config=row.get("config") or {},
        status=row.get("status", "pending"),
        status_detail=row.get("status_detail"),
        tool_policy=row.get("tool_policy", "ask"),
        position_x=row.get("position_x") or 0.0,
        position_y=row.get("position_y") or 0.0,
    )


def scratch_config() -> dict[str, Any]:
    """Config for a project's own scratch space. Hidden on the canvas."""
    return {
        "runtime": "e2b",
        "role": "scratch",
        "sandbox_id": None,
        "template": settings.e2b_template,
        "idle_timeout_s": settings.environment_idle_timeout_s,
        "preview_ports": [],
    }


class EnvironmentRepository:
    def __init__(self, client: Any, user_id: str) -> None:
        self._db = client
        self._user_id = user_id

    # -- nodes ----------------------------------------------------------------

    def create_environment_node(
        self,
        project_id: str,
        name: str,
        config: dict[str, Any],
        *,
        tool_policy: str = "ask",
        position_x: float = 0.0,
        position_y: float = 0.0,
    ) -> str:
        """Provision an environment box.

        Neither type id is set: nodes_type_matches_kind requires both null for
        this kind.
        """
        rows = (
            self._db.table("nodes")
            .insert(
                {
                    "project_id": project_id,
                    # Overwritten by nodes_sync_owner; supplied for the WITH CHECK.
                    "owner_id": self._user_id,
                    "kind": "environment",
                    "name": name,
                    "config": config,
                    "tool_policy": tool_policy,
                    "position_x": position_x,
                    "position_y": position_y,
                    "status": "pending",
                }
            )
            .execute()
        ).data
        return rows[0]["id"]

    def get_environment_node(self, node_id: str) -> EnvNode | None:
        rows = (
            self._db.table("nodes")
            .select(_ENV_COLUMNS)
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "environment")
            .limit(1)
            .execute()
        ).data
        return _to_env_node(rows[0]) if rows else None

    def list_environment_nodes(self, project_id: str) -> list[EnvNode]:
        rows = (
            self._db.table("nodes")
            .select(_ENV_COLUMNS)
            .eq("project_id", project_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "environment")
            .order("created_at")
            .execute()
        ).data
        return [_to_env_node(r) for r in rows]

    def update_environment_node(self, node_id: str, changes: dict[str, Any]) -> EnvNode | None:
        """Partial update. Status, config and kind are not client writable."""
        allowed = {"name", "position_x", "position_y", "tool_policy"}
        payload = {k: v for k, v in changes.items() if k in allowed and v is not None}
        if not payload:
            # A drag that ends where it started is a no-op, not an error.
            return self.get_environment_node(node_id)

        rows = (
            self._db.table("nodes")
            .update(payload)
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "environment")
            .execute()
        ).data
        return self.get_environment_node(node_id) if rows else None

    # -- scratch --------------------------------------------------------------

    def get_scratch_node(self, project_id: str) -> EnvNode | None:
        rows = (
            self._db.table("nodes")
            .select(_ENV_COLUMNS)
            .eq("project_id", project_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "environment")
            .eq("config->>role", "scratch")
            .limit(1)
            .execute()
        ).data
        return _to_env_node(rows[0]) if rows else None

    def ensure_scratch_node(self, project_id: str) -> EnvNode:
        """The project's own scratch space, created on first ask.

        nodes_one_scratch_per_project makes a concurrent second create fail
        rather than duplicate, so a unique violation means the other caller
        won and the row is there to read.
        """
        existing = self.get_scratch_node(project_id)
        if existing is not None:
            return existing

        try:
            self.create_environment_node(
                project_id, "Scratch Space", scratch_config(), tool_policy="auto"
            )
        except APIError as exc:
            if exc.code != _UNIQUE_VIOLATION:
                raise

        node = self.get_scratch_node(project_id)
        if node is None:
            raise RuntimeError(f"scratch node for project {project_id} could not be created")
        return node

    # -- status ---------------------------------------------------------------

    def set_status(self, node_id: str, status: str, detail: str | None) -> None:
        (
            self._db.table("nodes")
            .update(
                {
                    "status": status,
                    "status_detail": detail,
                    "last_checked_at": datetime.now(UTC).isoformat(),
                }
            )
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "environment")
            .execute()
        )

    def set_config(self, node_id: str, config: dict[str, Any]) -> None:
        (
            self._db.table("nodes")
            .update({"config": config})
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "environment")
            .execute()
        )

    def try_begin_provisioning(self, node_id: str) -> bool:
        """Compare and set. True means this caller owns the provisioning attempt.

        Two turns can reach a pending environment at once. The loser sees no
        row updated and reports the environment unavailable for that turn
        rather than starting a second sandbox.
        """
        rows = (
            self._db.table("nodes")
            .update({"status": "provisioning", "status_detail": None})
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "environment")
            .in_("status", _CLAIMABLE)
            .execute()
        ).data
        return bool(rows)
