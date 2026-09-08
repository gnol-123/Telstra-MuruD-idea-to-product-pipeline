"""Data access for projects, agent nodes and their conversations.

Every method filters on owner explicitly as well as relying on RLS, so a
misconfigured policy or a service-role key cannot cross a tenant boundary.

The Supabase client is synchronous, so async callers must dispatch these
through ``anyio.to_thread.run_sync``.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from postgrest.exceptions import APIError
from supabase import Client

# Postgres unique_violation, surfaced by PostgREST as `code`.
_UNIQUE_VIOLATION = "23505"

# How much history to replay into the model by default.
DEFAULT_HISTORY_LIMIT = 50


class DuplicateProjectName(Exception):
    """A user already has a project with this name."""


class DuplicateEdge(Exception):
    """An arrow of this kind already joins these two nodes."""


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
class InboundContext:
    """A context summary and its source agent."""

    source_node_id: str
    source_node_name: str
    summary: str


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


@dataclass(frozen=True)
class Edge:
    """A connection between two nodes on the canvas."""

    id: str
    source_node_id: str
    target_node_id: str
    kind: str
    summary: str | None
    summarised_through_seq: int | None
    summary_updated_at: str | None
    summary_max_words: int


def _to_edge(row: dict[str, Any]) -> Edge:
    return Edge(
        id=row["id"],
        source_node_id=row["source_node_id"],
        target_node_id=row["target_node_id"],
        kind=row["kind"],
        summary=row.get("summary"),
        summarised_through_seq=row.get("summarised_through_seq"),
        summary_updated_at=row.get("summary_updated_at"),
        summary_max_words=row.get("summary_max_words", 200),
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

    def delete_project(self, project_id: str) -> bool:
        """Delete a project and everything on its canvas.

        One statement: `on delete cascade` takes the nodes, edges,
        conversations and messages with it.
        """
        rows = (
            self._db.table("projects")
            .delete()
            .eq("id", project_id)
            .eq("owner_id", self._user_id)
            .execute()
        ).data
        return bool(rows)

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

    def update_agent_node(self, node_id: str, changes: dict[str, Any]) -> AgentNode | None:
        """Apply a partial update to an agent node.
        Only allowed fields are modifiable;
        {"name", "position_x", "position_y", "tool_policy"}
        """
        allowed = {"name", "position_x", "position_y", "tool_policy"}
        payload = {k: v for k, v in changes.items() if k in allowed and v is not None}
        if not payload:
            # A drag that ends where it started is a no-op, not an error.
            return self.get_agent_node(node_id)

        rows = (
            self._db.table("nodes")
            .update(payload)
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "agent")
            .execute()
        ).data
        return self.get_agent_node(node_id) if rows else None

    def delete_agent_node(self, node_id: str) -> bool:
        """Remove a node. Cascades to its conversation and transcript."""
        rows = (
            self._db.table("nodes")
            .delete()
            .eq("id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "agent")
            .execute()
        ).data
        return bool(rows)

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

    # -- edges --------------------------------------------------------------

    def create_edge(
        self,
        source_node_id: str,
        target_node_id: str,
        kind: str = "context",
    ) -> Edge:
        """
        Connect two nodes on the canvas.
        Returns the edge object.
        """
        try:
            rows = (
                self._db.table("edges")
                .insert(
                    {
                        "owner_id": self._user_id,
                        "source_node_id": source_node_id,
                        "target_node_id": target_node_id,
                        "kind": kind,
                    }
                )
                .execute()
            ).data
        except APIError as exc:
            if exc.code == _UNIQUE_VIOLATION:
                raise DuplicateEdge(f"{source_node_id} -> {target_node_id} ({kind})") from exc
            raise
        return _to_edge(rows[0])

    def list_edges(self, project_id: str) -> list[Edge]:
        """Every edge on a project's canvas."""
        rows = (
            self._db.table("edges")
            .select(
                "id, source_node_id, target_node_id, kind, summary,"
                " summarised_through_seq, summary_updated_at, summary_max_words"
            )
            .eq("project_id", project_id)
            .eq("owner_id", self._user_id)
            .execute()
        ).data
        return [_to_edge(r) for r in rows]

    def get_edge(self, edge_id: str) -> Edge | None:
        """One edge, if it belongs to the caller."""
        rows = (
            self._db.table("edges")
            .select(
                "id, source_node_id, target_node_id, kind, summary,"
                " summarised_through_seq, summary_updated_at, summary_max_words"
            )
            .eq("id", edge_id)
            .eq("owner_id", self._user_id)
            .limit(1)
            .execute()
        ).data
        return _to_edge(rows[0]) if rows else None

    def update_edge_summary(self, edge_id: str, summary: str, through_seq: int) -> Edge | None:
        """Store a freshly generated summary and how far up the source it covers."""
        rows = (
            self._db.table("edges")
            .update(
                {
                    "summary": summary,
                    "summarised_through_seq": through_seq,
                    "summary_updated_at": datetime.now(UTC).isoformat(),
                }
            )
            .eq("id", edge_id)
            .eq("owner_id", self._user_id)
            .eq("kind", "context")
            .execute()
        ).data
        return _to_edge(rows[0]) if rows else None

    def list_inbound_context(self, node_id: str) -> list[InboundContext]:
        """Summaries feeding this node, each named by its source agent.

        Joined by constraint name: `edges` has two foreign keys to `nodes`.
        Edges with no summary are omitted.
        """
        rows = (
            self._db.table("edges")
            .select("source_node_id, summary, nodes!edges_source_node_id_fkey(name)")
            .eq("target_node_id", node_id)
            .eq("kind", "context")
            .eq("owner_id", self._user_id)
            .execute()
        ).data
        out = []
        for r in rows:
            summary = (r.get("summary") or "").strip()
            if not summary:
                continue
            node = r.get("nodes") or {}
            out.append(
                InboundContext(
                    source_node_id=r["source_node_id"],
                    source_node_name=node.get("name", "another agent"),
                    summary=summary,
                )
            )
        return out

    def delete_edge(self, edge_id: str) -> bool:
        rows = (
            self._db.table("edges")
            .delete()
            .eq("id", edge_id)
            .eq("owner_id", self._user_id)
            .execute()
        ).data
        return bool(rows)

    def list_inbound_edges(self, node_id: str, kind: str) -> list[Edge]:
        """Return all edges where this node is the target."""
        rows = (
            self._db.table("edges")
            .select(
                "id, source_node_id, target_node_id, kind, summary,"
                " summarised_through_seq, summary_updated_at, summary_max_words"
            )
            .eq("target_node_id", node_id)
            .eq("owner_id", self._user_id)
            .eq("kind", kind)
            .execute()
        ).data
        return [_to_edge(r) for r in rows]

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

        winner = self.get_conversation_for_node(node_id)
        if winner is None:
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
        """
        Insert one message, returning the stored row.
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

    # -- stale context ---------------------------------------------------------

    def get_conversation_head(self, node_id: str) -> int:
        """Message count for this node's conversation. 0 when it has none."""
        rows = (
            self._db.table("conversations")
            .select("message_count")
            .eq("owner_id", self._user_id)
            .eq("node_id", node_id)
            .limit(1)
            .execute()
        ).data
        return rows[0]["message_count"] if rows else 0


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
