"""One turn's inputs: inbound context, toolsets, and the notes that describe them.

Shared by the chat routes and by the canvas tool's nested runs, so a stage
agent driven by an orchestrator gets exactly what it would get from a user.
"""

from dataclasses import dataclass

from anyio import to_thread

from app.environments.assembly import assemble_environments, merge_assembled
from app.repositories.project_repo import Node
from app.routers.deps import TurnRepositories
from app.tools.assembly import AssembledTools, assemble, record_calls, unavailable_note
from app.workflows import build_context_instructions


@dataclass(frozen=True)
class PreparedTurn:
    instructions: str | None
    # Recording-wrapped, ready for agent.run(toolsets=...).
    toolsets: list
    # Unwrapped assembly, for owner_by_tool on the approval path.
    tools: AssembledTools


async def prepare_turn(
    repos: TurnRepositories, node: Node, conversation_id: str, *, nested: bool = False
) -> PreparedTurn:
    """Build instructions and recording toolsets for one agent turn.

    ``nested`` is a turn started by a canvas tool rather than a request. Canvas
    boxes are reported unavailable there, so no wiring can start an
    orchestration inside an orchestration.
    """
    # Lazy: canvas imports this module.
    from app.tools.canvas import CANVAS_SLUG, assemble_canvas

    repo, tool_repo, env_repo = repos.project, repos.tool, repos.env

    context = await to_thread.run_sync(repo.list_inbound_context, node.id)
    instructions = build_context_instructions(context)

    tools = AssembledTools()
    tool_ids = await to_thread.run_sync(repo.list_inbound_tool_node_ids, node.id)
    if tool_ids:
        tool_nodes = [
            n
            for n in (
                await to_thread.run_sync(lambda: [tool_repo.get_tool_node(i) for i in tool_ids])
            )
            if n is not None
        ]
        canvas_nodes = [n for n in tool_nodes if n.tool_slug == CANVAS_SLUG]
        other_nodes = [n for n in tool_nodes if n.tool_slug != CANVAS_SLUG]
        ask = node.tool_policy == "ask"
        tools = await assemble(tool_repo, other_nodes, ask=ask)
        if canvas_nodes and nested:
            tools = merge_assembled(
                tools, AssembledTools(unavailable=[n.name for n in canvas_nodes])
            )
        elif canvas_nodes:
            tools = merge_assembled(
                tools, await assemble_canvas(repos, node, canvas_nodes, conversation_id, ask=ask)
            )

    env_ids = await to_thread.run_sync(repo.list_inbound_environment_node_ids, node.id)
    if env_ids:
        env_nodes = [
            n
            for n in (
                await to_thread.run_sync(
                    lambda: [env_repo.get_environment_node(i) for i in env_ids]
                )
            )
            if n is not None
        ]
        envs = await assemble_environments(env_repo, env_nodes, agent_node_id=node.id)
        tools = merge_assembled(tools, envs)

    parts = [instructions, *tools.notes, unavailable_note(tools.unavailable)]
    joined = "\n\n".join(p for p in parts if p) or None

    toolsets = record_calls(
        tools,
        repo=tool_repo,
        project_id=node.project_id,
        conversation_id=conversation_id,
        agent_node_id=node.id,
    )
    return PreparedTurn(instructions=joined, toolsets=toolsets, tools=tools)
