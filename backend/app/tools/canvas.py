"""Canvas tools: an orchestrator agent creating, wiring and running other agents.

Built per turn on the turn repositories, never from the registry: the
registry's build only sees a ToolContext, and these need the caller's repos.

Every model-supplied id goes through an owner-filtered read before any write.
The turn repositories bypass RLS, so that read is the tenant boundary.
"""

import json
import logging

from anyio import to_thread
from pydantic_ai.toolsets import ApprovalRequiredToolset, FunctionToolset

from app.repositories.project_repo import DuplicateEdge, Node
from app.repositories.tool_repo import ToolNode
from app.routers.deps import TurnRepositories
from app.routers.projects import provision_agent
from app.services.turns import prepare_turn
from app.tools.assembly import AssembledTools
from app.workflows import refresh_outbound, run_turn

log = logging.getLogger(__name__)

CANVAS_SLUG = "canvas"
TOOL_NAMES = ("list_canvas", "create_agent", "connect", "run_agent")

# Boundary box to keep margin between boxes
_STAGE_DX = 520
_STAGE_DY = 320
_ROW_TOLERANCE = 150
# Head of a stage reply returned to the orchestrator. 
_RESULT_HEAD = 6000

UNATTENDED_INSTRUCTION = (
    "You are being run by an orchestrator with no human in the loop. Do not ask "
    "questions. Record every assumption you make and proceed. Produce the "
    "complete deliverable in this reply."
)


class CanvasTools:
    """The four functions, bound to one orchestrator node and its turn repos."""

    def __init__(self, repos: TurnRepositories, orchestrator: Node) -> None:
        self._repos = repos
        self._orch = orchestrator

    # -- reads ---------------------------------------------------------------

    async def list_canvas(self) -> str:
        """The agent types you can create, the agents on this canvas, and the context
        edges between them. Call this first, every time: it is how you know what
        already exists and what each agent has produced so far."""
        repo = self._repos.project
        types, nodes, edges = await to_thread.run_sync(
            lambda: (
                repo.list_agent_types(),
                repo.list_nodes(self._orch.project_id),
                repo.list_edges(self._orch.project_id),
            )
        )
        agents = [n for n in nodes if n.kind == "agent"]
        heads = await to_thread.run_sync(
            lambda: {n.id: repo.get_conversation_head(n.id) for n in agents}
        )
        return json.dumps(
            {
                "agent_types": [
                    {"slug": t.slug, "name": t.name, "description": t.description}
                    for t in types
                    if t.slug != self._orch.agent_slug
                ],
                "agents": [
                    {
                        "id": n.id,
                        "name": n.name,
                        "agent_slug": n.agent_slug,
                        "tool_policy": n.tool_policy,
                        "message_count": heads.get(n.id, 0),
                        "is_orchestrator": n.id == self._orch.id,
                    }
                    for n in agents
                ],
                "edges": [
                    {
                        "source_node_id": e.source_node_id,
                        "target_node_id": e.target_node_id,
                        "has_summary": bool(e.summary),
                    }
                    for e in edges
                    if e.kind == "context"
                ],
            }
        )

    # -- writes --------------------------------------------------------------

    async def create_agent(self, agent_slug: str, name: str) -> str:
        """Create an agent on this canvas with its default tools. agent_slug is one of
        the slugs from list_canvas. name labels the box, e.g. "Market Research".
        Returns the new node id. Refuses a name that already exists: reuse that agent."""
        repo = self._repos.project
        if agent_slug == self._orch.agent_slug:
            return "Refused: an orchestrator cannot create another orchestrator."

        agent_type = await to_thread.run_sync(repo.get_agent_type, agent_slug)
        if agent_type is None or agent_type.id == self._orch.agent_type_id:
            types = await to_thread.run_sync(repo.list_agent_types)
            valid = ", ".join(t.slug for t in types if t.id != self._orch.agent_type_id)
            return f"Refused: unknown agent_slug '{agent_slug}'. Valid: {valid}."

        nodes = await to_thread.run_sync(repo.list_nodes, self._orch.project_id)
        agents = [n for n in nodes if n.kind == "agent"]
        existing = next((n for n in agents if n.name.strip().lower() == name.strip().lower()), None)
        if existing is not None:
            return f"An agent named '{existing.name}' already exists: id {existing.id}. Reuse it."

        row_y = self._orch.position_y + _STAGE_DY
        in_row = [n.position_x for n in agents if abs(n.position_y - row_y) < _ROW_TOLERANCE]
        x = max(in_row) + _STAGE_DX if in_row else self._orch.position_x

        node_id = await provision_agent(
            self._orch.project_id,
            agent_type,
            name,
            position_x=x,
            position_y=row_y,
            tool_policy="auto",
            repo=repo,
            tool_repo=self._repos.tool,
            env_repo=self._repos.env,
        )
        log.info(
            "canvas: %s created %s (%s) in project %s",
            self._orch.id,
            node_id,
            agent_slug,
            self._orch.project_id,
        )
        return f"Created '{name}' ({agent_slug}): id {node_id}."

    async def connect(
        self, source_node_id: str, target_node_id: str, summary_max_words: int = 1000
    ) -> str:
        """Give target agent a summary of source agent's conversation as context.
        Direction matters: source's findings flow into target. summary_max_words
        is how long that summary may be (20 to 2000)."""
        repo = self._repos.project
        src, tgt = await to_thread.run_sync(
            lambda: (repo.get_agent_node(source_node_id), repo.get_agent_node(target_node_id))
        )
        if src is None or tgt is None:
            missing = source_node_id if src is None else target_node_id
            return f"Refused: agent {missing} not found on this canvas."
        if src.project_id != self._orch.project_id or tgt.project_id != self._orch.project_id:
            return "Refused: both agents must be on this canvas."
        if src.id == tgt.id:
            return "Refused: an agent cannot feed itself."
        words = max(20, min(2000, summary_max_words))
        try:
            await to_thread.run_sync(
                lambda: repo.create_edge(src.id, tgt.id, "context", summary_max_words=words)
            )
        except DuplicateEdge:
            return f"Already connected: {src.name} -> {tgt.name}."
        log.info("canvas: %s connected %s -> %s", self._orch.id, src.id, tgt.id)
        return f"Connected: {src.name} -> {tgt.name} (summary up to {words} words)."

    async def run_agent(self, node_id: str, prompt: str) -> str:
        """Send prompt to an agent and wait for its reply. The agent runs unattended
        with its own tools and receives the context summaries wired into it.
        Returns the reply (head only if long). Afterwards its outbound context
        edges are refreshed, so the next agent you run sees what it settled."""
        repo, tool_repo = self._repos.project, self._repos.tool
        if node_id == self._orch.id:
            return "Refused: an orchestrator cannot run itself."
        target = await to_thread.run_sync(repo.get_agent_node, node_id)
        if target is None or target.project_id != self._orch.project_id:
            return f"Refused: agent {node_id} not found on this canvas."
        if target.agent_type_id == self._orch.agent_type_id:
            return "Refused: an orchestrator cannot run another orchestrator."

        conversation_id = await to_thread.run_sync(
            lambda: repo.get_or_create_conversation(target.id, target.project_id)
        )
        if await to_thread.run_sync(tool_repo.get_pending_run, conversation_id):
            return (
                f"Refused: {target.name} is waiting for a tool approval in its own chat. "
                "Resolve that first."
            )

        prepared = await prepare_turn(self._repos, target, conversation_id, nested=True)
        instructions = "\n\n".join(p for p in (UNATTENDED_INSTRUCTION, prepared.instructions) if p)

        log.info("canvas: %s running %s", self._orch.id, target.id)
        turn = await run_turn(
            repo,
            conversation_id,
            target.system_prompt,
            target.model,
            prompt,
            durable=False,
            instructions=instructions,
            toolsets=prepared.toolsets,
        )

        if turn.pending is not None:
            return (
                f"{target.name} paused for a tool approval and cannot be driven unattended. "
                "Set its tool_policy to auto, or approve it in its own chat, then run it again."
            )
        if turn.error is not None or (
            turn.assistant_message is not None and turn.assistant_message.status == "failed"
        ):
            return f"Agent failed: {target.name}: {turn.error}"

        failed = await refresh_outbound(repo, target.id)
        note = f"\n\n[Could not refresh context edges: {', '.join(failed)}]" if failed else ""

        output = turn.output
        if len(output) > _RESULT_HEAD:
            cut = output.rfind("\n", _RESULT_HEAD // 2, _RESULT_HEAD)
            head = output[:cut] if cut != -1 else output[:_RESULT_HEAD]
            output = head + (
                f"\n\n[Truncated: {len(turn.output)} characters in total. The full reply is on "
                f"{target.name}'s conversation.]"
            )
        return output + note

    def toolset(self) -> FunctionToolset:
        # Sequential: placement and the duplicate guard read before they write.
        toolset = FunctionToolset(sequential=True)
        for name in TOOL_NAMES:
            toolset.add_function(getattr(self, name), name=name)
        return toolset


async def assemble_canvas(
    repos: TurnRepositories, orchestrator: Node, nodes: list[ToolNode], *, ask: bool
) -> AssembledTools:
    """One canvas toolset for the turn. A second canvas box is reported unavailable.

    ``ask`` gates only run_agent: creating and wiring boxes is cheap and
    reversible, running an agent is the step that spends.
    """
    ready = [n for n in nodes if n.status == "ready"]
    if not ready:
        return AssembledTools(unavailable=[n.name for n in nodes])
    primary, extra = ready[0], [*ready[1:], *(n for n in nodes if n.status != "ready")]

    toolset = CanvasTools(repos, orchestrator).toolset()
    if ask:
        toolset = ApprovalRequiredToolset(
            toolset, approval_required_func=lambda ctx, tool, args: tool.name == "run_agent"
        )
    return AssembledTools(
        toolsets=[toolset],
        owner_by_tool=dict.fromkeys(TOOL_NAMES, primary.id),
        unavailable=[n.name for n in extra],
        owner_by_toolset=[primary.id],
    )
