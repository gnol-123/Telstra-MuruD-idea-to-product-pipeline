"""Canvas tools: an orchestrator agent creating, wiring and running other agents.

Built per turn on the turn repositories, never from the registry: the
registry's build only sees a ToolContext, and these need the caller's repos.

Every model-supplied id goes through an owner-filtered read before any write.
The turn repositories bypass RLS, so that read is the tenant boundary.
"""

import json
import logging

import anyio
from anyio import to_thread
from pydantic_ai.toolsets import ApprovalRequiredToolset, FunctionToolset

from app.repositories.project_repo import DuplicateEdge, Node
from app.repositories.tool_repo import ToolNode
from app.routers.deps import TurnRepositories
from app.routers.projects import provision_agent
from app.services import runs
from app.services.turns import prepare_turn
from app.tools.assembly import AssembledTools
from app.workflows import cancel_for_node, refresh_outbound, run_turn

log = logging.getLogger(__name__)

CANVAS_SLUG = "canvas"
EVALUATOR_SLUG = "evaluator"
TOOL_NAMES = (
    "list_canvas",
    "create_agent",
    "connect",
    "refresh_context",
    "give_environment",
    "run_agent",
    "evaluate",
)

# Boundary box to keep margin between boxes
_STAGE_DX = 520
_STAGE_DY = 320
_ROW_TOLERANCE = 150
# An agent's own environment sits to its right, clear of the tool column.
_ENV_DX = 260
# Head of a stage reply returned to the orchestrator.
_RESULT_HEAD = 6000
# Stage reply handed to an evaluator
_REPLY_HEAD = 12000

UNATTENDED_INSTRUCTION = (
    "You are being run by an orchestrator with no human in the loop. Do not ask "
    "questions. Record every assumption you make and proceed. Produce the "
    "complete deliverable in this reply."
)


def _is_stale(edge, source_head: int) -> bool:
    """Same rule as GET /edges: never summarised, or the source moved on since."""
    if edge.summarised_through_seq is None:
        return True
    return source_head > edge.summarised_through_seq


def _user_env_config() -> dict:
    """Config for an agent's own sandbox. Mirrors scratch_config with role=user.

    settings is imported here, not at module scope: this module is itself
    imported lazily from prepare_turn to avoid an import cycle, and pulling
    app.config in at module scope reorders initialisation enough to break
    environment assembly (tests/test_chat_environments.py catches it).
    """
    from app.config import settings

    return {
        "runtime": "e2b",
        "role": "user",
        "sandbox_id": None,
        "template": settings.e2b_template,
        "idle_timeout_s": settings.environment_idle_timeout_s,
        "preview_ports": [],
    }


class CanvasTools:
    """The seven functions, bound to one orchestrator node and its turn repos."""

    def __init__(self, repos: TurnRepositories, orchestrator: Node, conversation_id: str) -> None:
        self._repos = repos
        self._orch = orchestrator
        self._orch_conversation_id = conversation_id

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
                    if t.slug not in (self._orch.agent_slug, EVALUATOR_SLUG)
                ],
                "agents": [
                    {
                        "id": n.id,
                        "name": n.name,
                        "agent_slug": n.agent_slug,
                        "tool_policy": n.tool_policy,
                        # A seq, not a count: 0 means the agent has said nothing yet.
                        "last_complete_seq": heads.get(n.id, 0),
                        "is_orchestrator": n.id == self._orch.id,
                    }
                    for n in agents
                ],
                "edges": [
                    {
                        "source_node_id": e.source_node_id,
                        "target_node_id": e.target_node_id,
                        "has_summary": bool(e.summary),
                        "is_stale": _is_stale(e, heads.get(e.source_node_id, 0)),
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
        if agent_slug == EVALUATOR_SLUG:
            return "Refused: evaluators are created by evaluate, not by hand."

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

    async def refresh_context(self, node_id: str) -> str:
        """Regenerate the context summaries flowing OUT of one agent, so everything
        downstream of it sees what it knows now. run_agent already does this for
        the agent it ran, so you only need this when an agent's conversation moved
        on some other way: the user chatted with it directly, or list_canvas shows
        one of its outgoing edges as stale."""
        repo = self._repos.project
        node = await to_thread.run_sync(repo.get_agent_node, node_id)
        if node is None or node.project_id != self._orch.project_id:
            return f"Refused: agent {node_id} not found on this canvas."

        edges = await to_thread.run_sync(repo.list_outbound_context_edges, node.id)
        if not edges:
            return f"{node.name} has no outgoing context edges, so there is nothing to refresh."

        log.info("canvas: %s refreshing context out of %s", self._orch.id, node.id)
        failed = await refresh_outbound(repo, node.id)
        if failed:
            return (
                f"Refreshed {len(edges) - len(failed)} of {len(edges)} context edge(s) out of "
                f"{node.name}. Failed: {', '.join(failed)}."
            )
        return f"Refreshed {len(edges)} context edge(s) out of {node.name}."

    async def give_environment(self, node_id: str, name: str = "", share_from: str = "") -> str:
        """Give an agent its own sandbox, separate from the shared scratch space.

        Use this for an agent that needs to install packages, run a server or
        otherwise work without disturbing the other agents: the coding agent is
        the usual case. The agent keeps its scratch access, so it can still read
        what earlier stages wrote there; this adds a second, private sandbox on
        top. An agent that already has one is left alone.

        share_from: another agent's id; share its environment instead of creating
        one (the Scrutinizer reads the coding agent's code and screenshots this
        way)."""
        repo, env_repo = self._repos.project, self._repos.env
        node = await to_thread.run_sync(repo.get_agent_node, node_id)
        if node is None or node.project_id != self._orch.project_id:
            return f"Refused: agent {node_id} not found on this canvas."

        if share_from:
            src = await to_thread.run_sync(repo.get_agent_node, share_from)
            if src is None or src.project_id != self._orch.project_id:
                return f"Refused: agent {share_from} not found on this canvas."
            shared = await self._share_environments(src, node.id)
            if not shared:
                return f"Refused: {src.name} has no environment of its own to share."
            return f"{node.name} now shares {src.name}'s environment: {', '.join(shared)}."

        # Already has one? Adding a second would give the model two indistinct
        # sandboxes and no rule for choosing between them.
        env_ids = await to_thread.run_sync(repo.list_inbound_environment_node_ids, node.id)
        existing = [
            e
            for e in (
                await to_thread.run_sync(
                    lambda: [env_repo.get_environment_node(i) for i in env_ids]
                )
            )
            if e is not None and e.role == "user"
        ]
        if existing:
            return f"{node.name} already has its own environment: {existing[0].name}."

        env_name = (name or f"{node.name} Environment").strip()[:200]
        env_id = await to_thread.run_sync(
            lambda: env_repo.create_environment_node(
                self._orch.project_id,
                env_name,
                _user_env_config(),
                # auto, not the API default of ask: a stage agent driven by an
                # orchestrator has nobody to approve its shell commands.
                tool_policy="auto",
                position_x=node.position_x + _ENV_DX,
                position_y=node.position_y,
            )
        )
        try:
            await to_thread.run_sync(lambda: repo.create_edge(env_id, node.id, "environment"))
        except DuplicateEdge:
            pass
        log.info("canvas: %s gave %s its own environment %s", self._orch.id, node.id, env_id)
        return (
            f"Gave {node.name} its own environment '{env_name}' (id {env_id}). It starts on "
            "first use. The shared scratch space is still wired, so earlier stages' files "
            "remain readable."
        )

    async def _share_environments(self, src: Node, dst_id: str) -> list[str]:
        """Wire src's own environments into dst. Scratch is already on every agent."""
        repo, env_repo = self._repos.project, self._repos.env
        env_ids = await to_thread.run_sync(repo.list_inbound_environment_node_ids, src.id)
        envs = await to_thread.run_sync(lambda: [env_repo.get_environment_node(i) for i in env_ids])
        shared = []
        for env in envs:
            if env is None or env.role != "user":
                continue
            try:
                await to_thread.run_sync(lambda e=env: repo.create_edge(e.id, dst_id, "environment"))
            except DuplicateEdge:
                pass
            shared.append(env.name)
        return shared

    async def run_agent(self, node_id: str, prompt: str) -> str:
        """Send prompt to an agent and wait for its reply. The agent runs unattended
        with its own tools and receives the context summaries wired into it.
        Returns the reply (head only if long). Afterwards its outbound context
        edges are refreshed, so the next agent you run sees what it settled."""
        repo = self._repos.project
        if node_id == self._orch.id:
            return "Refused: an orchestrator cannot run itself."
        target = await to_thread.run_sync(repo.get_agent_node, node_id)
        if target is None or target.project_id != self._orch.project_id:
            return f"Refused: agent {node_id} not found on this canvas."
        if target.agent_type_id == self._orch.agent_type_id:
            return "Refused: an orchestrator cannot run another orchestrator."
        return await self._run(target, prompt)

    async def _run(self, target: Node, prompt: str, *, refresh: bool = True) -> str:
        """Run one turn on target and return its reply. Shared by run_agent and evaluate."""
        repo, tool_repo = self._repos.project, self._repos.tool
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
        parent = runs.get(self._orch_conversation_id)
        try:
            turn = await run_turn(
                repo,
                conversation_id,
                target.system_prompt,
                target.model,
                prompt,
                node_id=target.id,
                project_id=target.project_id,
                tool_repo=tool_repo,
                durable=False,
                instructions=instructions,
                toolsets=prepared.toolsets,
                parent=parent,
                sender_node_id=self._orch.id,
            )
        except runs.TurnBusy:
            return f"Refused: {target.name} is already running a turn."

        if turn.assistant_message is not None and turn.assistant_message.status == "cancelled":
            return f"Cancelled by user: {target.name}. Its partial reply is on its conversation."
        if turn.pending is not None:
            return (
                f"{target.name} paused for a tool approval and cannot be driven unattended. "
                "Set its tool_policy to auto, or approve it in its own chat, then run it again."
            )
        if turn.error is not None or (
            turn.assistant_message is not None and turn.assistant_message.status == "failed"
        ):
            return f"Agent failed: {target.name}: {turn.error}"

        note = ""
        if refresh:
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

    async def evaluate(self, node_id: str, criteria: str) -> str:
        """Check an agent's latest reply against criteria with a temporary evaluator.
        criteria: what that stage was asked to deliver, as a short checklist.
        Returns 'VERDICT: PASS' or 'VERDICT: FAIL' with up to 5 fixes. The
        evaluator shares the agent's environment and is deleted afterwards."""
        repo = self._repos.project
        target = await to_thread.run_sync(repo.get_agent_node, node_id)
        if target is None or target.project_id != self._orch.project_id:
            return f"Refused: agent {node_id} not found on this canvas."
        if target.agent_type_id == self._orch.agent_type_id or target.agent_slug == EVALUATOR_SLUG:
            return "Refused: only stage agents can be evaluated."
        agent_type = await to_thread.run_sync(repo.get_agent_type, EVALUATOR_SLUG)
        if agent_type is None:
            return "Refused: the evaluator agent type is not installed."

        conversation_id = await to_thread.run_sync(repo.get_conversation_for_node, target.id)
        messages = (
            await to_thread.run_sync(lambda: repo.list_messages(conversation_id, limit=10))
            if conversation_id
            else []
        )
        reply = next(
            (m.content for m in reversed(messages) if m.role == "assistant" and m.status == "complete" and m.content),
            "",
        )
        if not reply:
            return f"Refused: {target.name} has delivered nothing to evaluate yet."

        try:
            eval_id = await provision_agent(
                self._orch.project_id,
                agent_type,
                f"Eval: {target.name}",
                position_x=target.position_x,
                position_y=target.position_y + _STAGE_DY // 2,
                tool_policy="auto",
                repo=repo,
                tool_repo=self._repos.tool,
                env_repo=self._repos.env,
            )
        except Exception as exc:
            log.exception("canvas: could not create evaluator for %s", target.id)
            return f"Could not create an evaluator: {exc}"

        try:
            shared = await self._share_environments(target, eval_id)
            evaluator = await to_thread.run_sync(repo.get_agent_node, eval_id)
            where = (
                f"Its files are in its directory ({target.id}) of the shared environment: "
                f"{', '.join(shared)}."
                if shared
                else f"Its files, if any, are in its directory ({target.id}) of the shared scratch space."
            )
            prompt = (
                f"Evaluate {target.name}.\n\nCriteria:\n{criteria}\n\n{where}\n\n"
                f"Its latest reply:\n---\n{reply[:_REPLY_HEAD]}\n---"
            )
            log.info("canvas: %s evaluating %s with %s", self._orch.id, target.id, eval_id)
            return await self._run(evaluator, prompt, refresh=False)
        except Exception as exc:
            log.exception("canvas: evaluation of %s failed", target.id)
            return f"Evaluation failed: {exc}"
        finally:
            # Shielded: a cancelled orchestrator turn must not strand the box.
            with anyio.CancelScope(shield=True):
                await cancel_for_node(await to_thread.run_sync(repo.get_conversation_for_node, eval_id))
                await to_thread.run_sync(repo.delete_node, eval_id)

    def toolset(self) -> FunctionToolset:
        # Sequential: placement and the duplicate guard read before they write.
        toolset = FunctionToolset(sequential=True)
        for name in TOOL_NAMES:
            toolset.add_function(getattr(self, name), name=name)
        return toolset


async def assemble_canvas(
    repos: TurnRepositories,
    orchestrator: Node,
    nodes: list[ToolNode],
    conversation_id: str,
    *,
    ask: bool,
) -> AssembledTools:
    """One canvas toolset for the turn. A second canvas box is reported unavailable.

    ``ask`` gates run_agent and evaluate: creating and wiring boxes is cheap and
    reversible, running an agent is the step that spends. refresh_context is
    on the cheap side too, a summariser call over one transcript, and gating
    it would interrupt the pause/resume flow for bookkeeping the user has no
    reason to adjudicate. give_environment writes a row at status pending; the
    sandbox itself only starts on first use, inside a run_agent call that is
    already gated, so the spend stays behind the same approval.
    """
    ready = [n for n in nodes if n.status == "ready"]
    if not ready:
        return AssembledTools(unavailable=[n.name for n in nodes])
    primary, extra = ready[0], [*ready[1:], *(n for n in nodes if n.status != "ready")]

    toolset = CanvasTools(repos, orchestrator, conversation_id).toolset()
    if ask:
        toolset = ApprovalRequiredToolset(
            toolset, approval_required_func=lambda ctx, tool, args: tool.name in ("run_agent", "evaluate")
        )
    return AssembledTools(
        toolsets=[toolset],
        owner_by_tool=dict.fromkeys(TOOL_NAMES, primary.id),
        unavailable=[n.name for n in extra],
        owner_by_toolset=[primary.id],
    )
