"""Tool node, secret and call access.

Mirrors ProjectRepository: the client is injected, and every query also filters
on ownership so a policy mistake cannot cross tenants.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.services.supabase import get_service_client

_TOOL_TYPE_COLUMNS = "id, slug, name, description, config_schema, secret_fields, auth_kind"
_TOOL_NODE_COLUMNS = (
    "id, project_id, name, tool_type_id, config, status, status_detail, tool_types(slug)"
)
_TOOL_CALL_COLUMNS = (
    "id, project_id, conversation_id, agent_node_id, tool_node_id, tool_call_id,"
    " tool_name, arguments, status, result, error, duration_ms, created_at, updated_at"
)


@dataclass(frozen=True)
class ToolType:
    id: str
    slug: str
    name: str
    description: str | None
    config_schema: dict[str, Any]
    secret_fields: list[str]
    auth_kind: str = "token"


@dataclass(frozen=True)
class ToolNode:
    id: str
    project_id: str
    name: str
    tool_type_id: str
    tool_slug: str
    config: dict[str, Any]
    status: str
    status_detail: str | None


def _to_tool_type(row: dict[str, Any]) -> ToolType:
    return ToolType(
        id=row["id"],
        slug=row["slug"],
        name=row["name"],
        description=row.get("description"),
        config_schema=row.get("config_schema") or {},
        secret_fields=row.get("secret_fields") or [],
        auth_kind=row.get("auth_kind") or "token",
    )


def _to_tool_node(row: dict[str, Any]) -> ToolNode:
    tool_type = row.get("tool_types") or {}
    return ToolNode(
        id=row["id"],
        project_id=row["project_id"],
        name=row["name"],
        tool_type_id=row["tool_type_id"],
        tool_slug=tool_type.get("slug", ""),
        config=row.get("config") or {},
        status=row.get("status", "pending"),
        status_detail=row.get("status_detail"),
    )


class ToolRepository:
    def __init__(self, client: Any, user_id: str) -> None:
        self._db = client
        self._user_id = user_id

    # -- catalog ------------------------------------------------------------

    def list_tool_types(self) -> list[ToolType]:
        rows = (
            self._db.table("tool_types")
            .select(_TOOL_TYPE_COLUMNS)
            .eq("is_active", True)
            .order("sort_order")
            .execute()
        ).data
        return [_to_tool_type(r) for r in rows]

    def get_tool_type(self, slug: str) -> ToolType | None:
        rows = (
            self._db.table("tool_types")
            .select(_TOOL_TYPE_COLUMNS)
            .eq("slug", slug)
            .limit(1)
            .execute()
        ).data
        return _to_tool_type(rows[0]) if rows else None

    # -- nodes ----------------------------------------------------------------

    def create_tool_node(
        self,
        project_id: str,
        tool_type_id: str,
        name: str,
        config: dict,
        *,
        position_x: float = 0,
        position_y: float = 0,
    ) -> str:
        """Provision a tool node. Must not set agent_type_id.

        Setting both tool_type_id and agent_type_id violates
        nodes_type_matches_kind.
        """
        rows = (
            self._db.table("nodes")
            .insert(
                {
                    "project_id": project_id,
                    "kind": "tool",
                    "tool_type_id": tool_type_id,
                    "name": name,
                    "config": config,
                    "position_x": position_x,
                    "position_y": position_y,
                    "status": "pending",
                }
            )
            .execute()
        ).data
        return rows[0]["id"]

    def get_tool_node(self, node_id: str) -> ToolNode | None:
        rows = (
            self._db.table("nodes")
            .select(_TOOL_NODE_COLUMNS)
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "tool")
            .limit(1)
            .execute()
        ).data
        return _to_tool_node(rows[0]) if rows else None

    def set_node_config(self, node_id: str, config: dict[str, Any]) -> None:
        (
            self._db.table("nodes")
            .update({"config": config})
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "tool")
            .execute()
        )

    def set_node_status(self, node_id: str, status: str, detail: str | None) -> None:
        (
            self._db.table("nodes")
            .update({"status": status, "status_detail": detail})
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "tool")
            .execute()
        )

    # -- secrets --------------------------------------------------------------

    def set_secret(self, node_id: str, key: str, value: str) -> None:
        self._db.rpc(
            "set_node_secret",
            {"p_node_id": node_id, "p_key": key, "p_value": value},
        ).execute()

    def secret_keys(self, node_id: str) -> list[str]:
        rows = (
            self._db.table("node_secrets")
            .select("key")
            .eq("node_id", node_id)
            .eq("owner_id", self._user_id)
            .execute()
        ).data
        return [r["key"] for r in rows]

    # -- tool calls -------------------------------------------------------------

    def record_call(
        self,
        *,
        project_id: str,
        conversation_id: str,
        agent_node_id: str,
        tool_node_id: str,
        tool_call_id: str,
        tool_name: str,
        arguments: dict,
        status: str,
    ) -> str:
        """Start (or restart) recording one call. Idempotent per
        (conversation_id, tool_call_id).
        """
        existing = (
            self._db.table("tool_calls")
            .select("id")
            .eq("conversation_id", conversation_id)
            .eq("tool_call_id", tool_call_id)
            .eq("owner_id", self._user_id)
            .limit(1)
            .execute()
        ).data
        if existing:
            call_id = existing[0]["id"]
            (
                self._db.table("tool_calls")
                .update({"status": status, "arguments": arguments})
                .eq("id", call_id)
                .eq("owner_id", self._user_id)
                .execute()
            )
            return call_id

        rows = (
            self._db.table("tool_calls")
            .insert(
                {
                    "project_id": project_id,
                    "conversation_id": conversation_id,
                    "agent_node_id": agent_node_id,
                    "tool_node_id": tool_node_id,
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "arguments": arguments,
                    "status": status,
                }
            )
            .execute()
        ).data
        return rows[0]["id"]

    def finish_call(
        self,
        call_id: str,
        *,
        status: str,
        result: str | None = None,
        error: str | None = None,
        duration_ms: int | None = None,
    ) -> None:
        payload: dict[str, Any] = {"status": status}
        for key, value in (
            ("result", result),
            ("error", error),
            ("duration_ms", duration_ms),
        ):
            if value is not None:
                payload[key] = value
        (
            self._db.table("tool_calls")
            .update(payload)
            .eq("id", call_id)
            .eq("owner_id", self._user_id)
            .execute()
        )

    def get_call_by_tool_call_id(
        self, conversation_id: str, tool_call_id: str
    ) -> dict[str, Any] | None:
        """Look up a tool_calls row by its model-assigned call id.

        Used to check for an existing row before inserting one, since
        (conversation_id, tool_call_id) is unique.
        """
        rows = (
            self._db.table("tool_calls")
            .select(_TOOL_CALL_COLUMNS)
            .eq("conversation_id", conversation_id)
            .eq("tool_call_id", tool_call_id)
            .eq("owner_id", self._user_id)
            .limit(1)
            .execute()
        ).data
        return rows[0] if rows else None

    def finish_call_by_tool_call_id(
        self,
        conversation_id: str,
        tool_call_id: str,
        *,
        status: str,
        result: str | None = None,
        error: str | None = None,
    ) -> None:
        """Update a tool_calls row keyed by its model-assigned call id.

        Used on resume: the internal row id from the original turn may not
        be known after a backend restart, but tool_call_id always is.
        """
        payload: dict[str, Any] = {"status": status}
        if result is not None:
            payload["result"] = result
        if error is not None:
            payload["error"] = error
        (
            self._db.table("tool_calls")
            .update(payload)
            .eq("conversation_id", conversation_id)
            .eq("tool_call_id", tool_call_id)
            .eq("owner_id", self._user_id)
            .execute()
        )

    def list_calls(self, tool_node_id: str, limit: int = 50) -> list[dict[str, Any]]:
        rows = (
            self._db.table("tool_calls")
            .select(_TOOL_CALL_COLUMNS)
            .eq("tool_node_id", tool_node_id)
            .eq("owner_id", self._user_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        ).data
        return list(rows)

    # -- pending run --------------------------------------------------------

    def set_pending_run(self, conversation_id: str, payload: str | None) -> None:
        (
            self._db.table("conversations")
            .update(
                {
                    "pending_run": payload,
                    "pending_run_at": datetime.now(UTC).isoformat() if payload else None,
                }
            )
            .eq("id", conversation_id)
            .eq("owner_id", self._user_id)
            .execute()
        )

    def get_pending_run(self, conversation_id: str) -> tuple[str, datetime] | None:
        rows = (
            self._db.table("conversations")
            .select("pending_run, pending_run_at")
            .eq("id", conversation_id)
            .eq("owner_id", self._user_id)
            .limit(1)
            .execute()
        ).data
        if not rows:
            return None
        row = rows[0]
        payload = row.get("pending_run")
        at = row.get("pending_run_at")
        if not payload or not at:
            return None
        return payload, datetime.fromisoformat(at)


def get_tool_node_for_owner(node_id: str, owner_id: str) -> ToolNode | None:
    """Read a tool node with no caller JWT, for the oauth callback.

    Service-role client, filtered by the owner_id a verified signed state
    already proved. Same shape as ToolRepository.get_tool_node, minus the
    caller-scoped client.
    """
    client = get_service_client()
    rows = (
        client.table("nodes")
        .select(_TOOL_NODE_COLUMNS)
        .eq("id", node_id)
        .eq("owner_id", owner_id)
        .eq("kind", "tool")
        .limit(1)
        .execute()
    ).data
    return _to_tool_node(rows[0]) if rows else None


def secret_keys_for_owner(node_id: str, owner_id: str) -> list[str]:
    """Secret key names with no caller JWT, for the oauth callback."""
    client = get_service_client()
    rows = (
        client.table("node_secrets")
        .select("key")
        .eq("node_id", node_id)
        .eq("owner_id", owner_id)
        .execute()
    ).data
    return [r["key"] for r in rows]


def set_node_status_for_owner(node_id: str, owner_id: str, status: str, detail: str | None) -> None:
    """Write node status with no caller JWT, for the oauth callback."""
    client = get_service_client()
    (
        client.table("nodes")
        .update({"status": status, "status_detail": detail})
        .eq("id", node_id)
        .eq("owner_id", owner_id)
        .eq("kind", "tool")
        .execute()
    )


def set_node_config_for_owner(node_id: str, owner_id: str, config: dict[str, Any]) -> None:
    """Write node config with no caller JWT, for the oauth callback."""
    client = get_service_client()
    (
        client.table("nodes")
        .update({"config": config})
        .eq("id", node_id)
        .eq("owner_id", owner_id)
        .eq("kind", "tool")
        .execute()
    )


def load_node_secrets(node_id: str, keys: list[str]) -> dict[str, str]:
    """Decrypt a tool node's secrets.

    The only privilege escalation in the codebase: it uses the service-role
    client instead of the caller's. Call it after the caller's own client has
    confirmed they own the node. Values are never logged.

    get_node_secret returns NULL both when no secret row exists for the key
    and when the row exists with a null vault_secret_id. Either case is
    treated as "key not present" and the key is simply omitted, not raised.
    """
    if not keys:
        return {}
    client = get_service_client()
    out: dict[str, str] = {}
    for key in keys:
        data = client.rpc("get_node_secret", {"p_node_id": node_id, "p_key": key}).execute().data
        # Scalar-returning RPC: some client versions wrap the result in a
        # single-row list/dict. Handle a bare scalar or the wrapped shapes.
        if isinstance(data, list):
            value = data[0] if data else None
            if isinstance(value, dict):
                value = next(iter(value.values()), None)
        elif isinstance(data, dict):
            value = next(iter(data.values()), None)
        else:
            value = data
        if value:
            out[key] = value
    return out


def set_node_secret_as(node_id: str, owner_id: str, key: str, value: str) -> None:
    """Write a node secret with no caller JWT, for the oauth callback.

    Uses the service-role client against set_node_secret_as, the twin of
    set_node_secret that checks the given owner_id instead of auth.uid().
    Call only after verifying a signed state proves owner_id, never with a
    caller-supplied owner_id.
    """
    client = get_service_client()
    client.rpc(
        "set_node_secret_as",
        {"p_node_id": node_id, "p_owner_id": owner_id, "p_key": key, "p_value": value},
    ).execute()
