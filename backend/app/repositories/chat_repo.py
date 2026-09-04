"""Data access for projects, agent nodes and their conversations.

Every method filters on owner explicitly as well as relying on RLS, so a
misconfigured policy or a service-role key cannot cross a tenant boundary.

The Supabase client is synchronous, so async callers must dispatch these
through ``anyio.to_thread.run_sync``.
"""

from dataclasses import dataclass
from typing import Any

from postgrest.exceptions import APIError
from supabase import Client

# Postgres unique_violation, surfaced by PostgREST as `code`.
_UNIQUE_VIOLATION = "23505"

# How much history to replay into the model by default.
DEFAULT_HISTORY_LIMIT = 50


class DuplicateProjectName(Exception):
    """A user already has a project with this name."""


@dataclass(frozen=True)
class AgentType:
    """A row from the agent_types catalog."""

    id: str
    slug: str
    name: str
    system_prompt: str
    model: str


@dataclass(frozen=True)
class Project:
    id: str
    name: str


@dataclass(frozen=True)
class AgentNode:
    """A provisioned agent box, joined to the template it was built from."""

    id: str
    project_id: str
    name: str
    agent_type_id: str
    system_prompt: str
    model: str
    tool_policy: str


@dataclass(frozen=True)
class Message:
    id: str
    role: str
    content: str
    seq: int
    status: str
    created_at: str


def _to_message(row: dict[str, Any]) -> Message:
    return Message(
        id=row["id"],
        role=row["role"],
        content=row["content"],
        seq=row["seq"],
        status=row["status"],
        created_at=row["created_at"],
    )


class ChatRepository:
    """PostgREST access scoped to one user."""

    def __init__(self, client: Client, user_id: str) -> None:
        self._db = client
        self._user_id = user_id

    # -- catalog ------------------------------------------------------------

    def list_agent_types(self) -> list[AgentType]:
        rows = (
            self._db.table("agent_types")
            .select("id, slug, name, system_prompt, model")
            .eq("is_active", True)
            .order("sort_order")
            .execute()
        ).data
        return [
            AgentType(
                id=r["id"],
                slug=r["slug"],
                name=r["name"],
                system_prompt=r["system_prompt"],
                model=r["model"],
            )
            for r in rows
        ]

    def get_agent_type(self, slug: str) -> AgentType | None:
        rows = (
            self._db.table("agent_types")
            .select("id, slug, name, system_prompt, model")
            .eq("slug", slug)
            .eq("is_active", True)
            .limit(1)
            .execute()
        ).data
        if not rows:
            return None
        r = rows[0]
        return AgentType(
            id=r["id"],
            slug=r["slug"],
            name=r["name"],
            system_prompt=r["system_prompt"],
            model=r["model"],
        )

    # -- projects -----------------------------------------------------------

    def create_project(self, name: str, description: str | None = None) -> Project:
        """Create a project. Names are unique per user."""
        try:
            rows = (
                self._db.table("projects")
                .insert({"owner_id": self._user_id, "name": name, "description": description})
                .execute()
            ).data
        except APIError as exc:
            if exc.code == _UNIQUE_VIOLATION:
                raise DuplicateProjectName(name) from exc
            raise
        return Project(id=rows[0]["id"], name=rows[0]["name"])

    def list_projects(self) -> list[Project]:
        rows = (
            self._db.table("projects")
            .select("id, name")
            .eq("owner_id", self._user_id)
            .is_("archived_at", "null")
            .order("created_at", desc=True)
            .execute()
        ).data
        return [Project(id=r["id"], name=r["name"]) for r in rows]

    def get_project(self, project_id: str) -> Project | None:
        rows = (
            self._db.table("projects")
            .select("id, name")
            .eq("id", project_id)
            .eq("owner_id", self._user_id)
            .limit(1)
            .execute()
        ).data
        return Project(id=rows[0]["id"], name=rows[0]["name"]) if rows else None

    # -- nodes --------------------------------------------------------------

    def create_agent_node(
        self,
        project_id: str,
        agent_type_id: str,
        name: str,
        *,
        position_x: float = 0,
        position_y: float = 0,
    ) -> str:
        """Provision an agent box and give it a conversation.

        The conversation is created here rather than lazily on first message,
        so a freshly dropped box is immediately chattable.
        """
        rows = (
            self._db.table("nodes")
            .insert(
                {
                    "project_id": project_id,
                    # Satisfies the defensive WITH CHECK; a trigger overwrites
                    # it from the parent project, so a forged value is inert.
                    "owner_id": self._user_id,
                    "kind": "agent",
                    "agent_type_id": agent_type_id,
                    "name": name,
                    "position_x": position_x,
                    "position_y": position_y,
                    "status": "ready",
                }
            )
            .execute()
        ).data
        node_id = rows[0]["id"]
        self._create_conversation(node_id, project_id)
        return node_id

    def list_agent_nodes(self, project_id: str) -> list[AgentNode]:
        rows = (
            self._db.table("nodes")
            .select(
                "id, project_id, name, agent_type_id, tool_policy,"
                " agent_types(system_prompt, model)"
            )
            .eq("project_id", project_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "agent")
            .order("created_at")
            .execute()
        ).data
        return [_to_agent_node(r) for r in rows]

    def get_agent_node(self, node_id: str) -> AgentNode | None:
        """Load one agent box together with its template's prompt and model."""
        rows = (
            self._db.table("nodes")
            .select(
                "id, project_id, name, agent_type_id, tool_policy,"
                " agent_types(system_prompt, model)"
            )
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "agent")
            .limit(1)
            .execute()
        ).data
        return _to_agent_node(rows[0]) if rows else None

    # -- conversations ------------------------------------------------------

    def get_conversation_for_node(self, node_id: str) -> str | None:
        rows = (
            self._db.table("conversations")
            .select("id")
            .eq("node_id", node_id)
            .eq("owner_id", self._user_id)
            .limit(1)
            .execute()
        ).data
        return rows[0]["id"] if rows else None

    def get_or_create_conversation(self, node_id: str, project_id: str) -> str:
        """Return the node's conversation, creating it if it is somehow absent.

        Normally created alongside the node; this covers nodes provisioned
        before that, and races between two first messages.
        """
        existing = self.get_conversation_for_node(node_id)
        if existing is not None:
            return existing
        return self._create_conversation(node_id, project_id)

    def _create_conversation(self, node_id: str, project_id: str) -> str:
        try:
            rows = (
                self._db.table("conversations")
                .insert(
                    {
                        "node_id": node_id,
                        "project_id": project_id,
                        "owner_id": self._user_id,
                    }
                )
                .execute()
            ).data
            if rows:
                return rows[0]["id"]
        except APIError as exc:
            if exc.code != _UNIQUE_VIOLATION:
                raise

        # Lost a race against another first message: read the winner.
        winner = self.get_conversation_for_node(node_id)
        if winner is None:  # pragma: no cover - would mean the row vanished
            raise RuntimeError("conversation could not be created or found")
        return winner

    # -- messages -----------------------------------------------------------

    def list_messages(
        self, conversation_id: str, limit: int = DEFAULT_HISTORY_LIMIT
    ) -> list[Message]:
        """Return the most recent ``limit`` messages, oldest first.

        Ordered descending then reversed: a plain ascending ``limit`` would
        return the *oldest* N and silently freeze context after N turns.
        """
        rows = (
            self._db.table("messages")
            .select("id, role, content, seq, status, created_at")
            .eq("conversation_id", conversation_id)
            .eq("owner_id", self._user_id)
            .order("seq", desc=True)
            .limit(limit)
            .execute()
        ).data
        return [_to_message(r) for r in reversed(rows)]

    def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        client_token: str | None = None,
        model: str | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        reasoning_tokens: int | None = None,
        status: str = "complete",
        error: str | None = None,
    ) -> Message:
        """Insert one message, returning the stored row.

        ``seq`` and ``owner_id`` are assigned by database triggers. A
        ``client_token`` collision means a resend or a replayed step, so the
        existing row is returned instead of raising.
        """
        payload: dict[str, Any] = {
            "conversation_id": conversation_id,
            "owner_id": self._user_id,
            "role": role,
            "content": content,
            "status": status,
        }
        for key, value in (
            ("client_token", client_token),
            ("model", model),
            ("input_tokens", input_tokens),
            ("output_tokens", output_tokens),
            ("reasoning_tokens", reasoning_tokens),
            ("error", error),
        ):
            if value is not None:
                payload[key] = value

        try:
            rows = self._db.table("messages").insert(payload).execute().data
        except APIError as exc:
            if exc.code == _UNIQUE_VIOLATION and client_token is not None:
                existing = self._find_by_client_token(conversation_id, client_token)
                if existing is not None:
                    return existing
            raise

        return _to_message(rows[0])

    def _find_by_client_token(self, conversation_id: str, client_token: str) -> Message | None:
        rows = (
            self._db.table("messages")
            .select("id, role, content, seq, status, created_at")
            .eq("conversation_id", conversation_id)
            .eq("client_token", client_token)
            .eq("owner_id", self._user_id)
            .limit(1)
            .execute()
        ).data
        return _to_message(rows[0]) if rows else None


def _to_agent_node(row: dict[str, Any]) -> AgentNode:
    """Flatten a node row joined to its agent_types template."""
    template = row.get("agent_types") or {}
    return AgentNode(
        id=row["id"],
        project_id=row["project_id"],
        name=row["name"],
        agent_type_id=row["agent_type_id"],
        system_prompt=template.get("system_prompt", ""),
        model=template.get("model", ""),
        tool_policy=row.get("tool_policy", "ask"),
    )
