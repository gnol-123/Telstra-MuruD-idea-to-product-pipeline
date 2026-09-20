"use client";

import { useEffect, useRef, useState } from "react";
import {
  Project,
  AgentType,
  ToolType,
  ToolPreset,
  ProjectNode,
  Edge,
  EdgeKind,
  ToolPolicy,
  isAgentNode,
  isToolNode,
  isEnvironmentNode,
} from "@/lib/types";
import {
  getAgentTypes,
  getToolTypes,
  getToolPresets,
  listNodes,
  createAgentNode,
  createToolNode,
  createEnvironmentNode,
  updateNode,
  updateEnvironment,
  deleteNode,
  listEdges,
  createEdge,
  refreshEdge,
  deleteEdge,
  ApiError,
} from "@/lib/api";
import Palette, { PaletteTab } from "./Palette";
import NodeCard, { AttachedTool } from "./NodeCard";
import EdgeLayer, { LinkDraft, LAYER_W, LAYER_H } from "./EdgeLayer";
import Inspector, { ChatState, defaultChatState } from "./Inspector";
import ToolConfigModal from "./ToolConfigModal";

// Defensive: if the backend ever returns the same row twice (e.g. a join
// without DISTINCT), collapsing by id here keeps React's keys unique
// instead of crashing the canvas. Keeps the last occurrence.
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return [...map.values()];
}

export default function MeshCanvas({
  project,
  onBack,
}: {
  project: Project;
  onBack: () => void;
}) {
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [toolTypes, setToolTypes] = useState<ToolType[]>([]);
  const [toolPresets, setToolPresets] = useState<ToolPreset[]>([]);
  const [nodes, setNodes] = useState<ProjectNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paletteTab, setPaletteTab] = useState<PaletteTab>("agents");
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [refreshingEdgeId, setRefreshingEdgeId] = useState<string | null>(null);
  const [toolModal, setToolModal] = useState<{
    toolType: ToolType;
    position: { x: number; y: number };
    attachToAgentId?: string;
  } | null>(null);
  // Keyed by agent node id — kept here, above the Inspector, so a
  // conversation survives switching to another node and back. The API has
  // no endpoint to re-fetch a conversation's history (see API.md's "Not
  // implemented yet"), so this is the only copy of it once it's sent.
  const [chatByNode, setChatByNode] = useState<Record<string, ChatState>>({});
  const canvasRef = useRef<HTMLDivElement | null>(null);

  async function reloadCanvas() {
    try {
      const [ns, es] = await Promise.all([listNodes(project.id), listEdges(project.id)]);
      setNodes(dedupeById(ns));
      setEdges(dedupeById(es));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not refresh the canvas");
    }
  }

  useEffect(() => {
    getAgentTypes().then(setAgentTypes).catch((e: ApiError) => setError(e.message));
    getToolTypes().then(setToolTypes).catch((e: ApiError) => setError(e.message));
    getToolPresets().then(setToolPresets).catch((e: ApiError) => setError(e.message));
    listNodes(project.id)
      .then((ns) => setNodes(dedupeById(ns)))
      .catch((e: ApiError) => setError(e.message));
    listEdges(project.id)
      .then((es) => setEdges(dedupeById(es)))
      .catch((e: ApiError) => setError(e.message));
  }, [project.id]);

  // Per the teammate's node-status addition: every node row (agent, tool,
  // environment) now carries status/status_detail (see NodeResponse in
  // routers/projects.py). Poll the list every 2s and merge just those two
  // fields into whatever's already on screen — never overwriting position or
  // anything else a drag gesture owns, and skipping the setState entirely
  // when nothing actually changed so this doesn't fight an in-progress drag.
  useEffect(() => {
    const interval = setInterval(() => {
      listNodes(project.id)
        .then((fresh) => {
          const byId = new Map(fresh.map((n) => [n.id, n]));
          setNodes((prev) => {
            let changed = false;
            const next = prev.map((n) => {
              const f = byId.get(n.id) as (ProjectNode & { status?: string; status_detail?: string | null }) | undefined;
              if (!f || !("status" in f)) return n;
              const cur = n as ProjectNode & { status?: string; status_detail?: string | null };
              if (cur.status === f.status && cur.status_detail === f.status_detail) return n;
              changed = true;
              return { ...n, status: f.status, status_detail: f.status_detail } as ProjectNode;
            });
            return changed ? next : prev;
          });
        })
        .catch(() => {
          // Best-effort — a failed poll just tries again on the next tick.
        });
    }, 2000);
    return () => clearInterval(interval);
  }, [project.id]);

  function relPos(e: { clientX: number; clientY: number }) {
    const c = canvasRef.current;
    if (!c) return { x: e.clientX, y: e.clientY };
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left + c.scrollLeft, y: e.clientY - r.top + c.scrollTop };
  }

  // Where a tool/preset lands visually if it's created near an agent it's
  // being equipped on — mostly cosmetic since equipped tools show as chips
  // on the card, but it keeps the node discoverable nearby if it's ever
  // unequipped again.
  function posNearAgent(agent: ProjectNode) {
    return { x: agent.position_x ?? 0, y: (agent.position_y ?? 0) + 220 };
  }

  async function handleAddAgent(agentSlug: string, pos?: { x: number; y: number }) {
    try {
      const offset = nodes.length * 40;
      const node = await createAgentNode(project.id, agentSlug, {
        position_x: pos?.x ?? 120 + offset,
        position_y: pos?.y ?? 100 + offset,
      });
      setNodes((n) => dedupeById([...n, node]));
      setSelectedId(node.id);

      // "kind='agent' now provisions the agent type's default_presets": one
      // tool node + tool edge per preset, created server-side alongside the
      // agent. The response above is still just the agent's own node, so
      // reload to pick up whatever else the backend just created.
      const agentType = agentTypes.find((t) => t.slug === agentSlug);
      await reloadCanvas();
      if (agentType?.default_presets && agentType.default_presets.length > 0) {
        setNotice(
          `${agentType.name} came equipped with ${agentType.default_presets.length} default tool${
            agentType.default_presets.length === 1 ? "" : "s"
          } — see the chips on its card.`
        );
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not add agent");
    }
  }

  function openToolConfig(toolSlug: string, pos?: { x: number; y: number }, attachToAgentId?: string) {
    const toolType = toolTypes.find((t) => t.slug === toolSlug);
    if (!toolType) return;
    const offset = nodes.length * 40;
    setToolModal({
      toolType,
      position: pos ?? { x: 120 + offset, y: 100 + offset },
      attachToAgentId,
    });
  }

  async function handleAddPreset(
    presetSlug: string,
    pos?: { x: number; y: number },
    attachToAgentId?: string
  ) {
    const preset = toolPresets.find((p) => p.slug === presetSlug);
    if (!preset) return;
    const offset = nodes.length * 40;
    const position = pos ?? { x: 120 + offset, y: 100 + offset };
    try {
      const node = await createToolNode(project.id, {
        presetSlug: preset.slug,
        name: preset.name,
        position_x: position.x,
        position_y: position.y,
      });
      setNodes((n) => dedupeById([...n, node]));

      if (attachToAgentId) {
        try {
          const edge = await createEdge(project.id, node.id, attachToAgentId, "tool");
          setEdges((es) => dedupeById([...es, edge]));
          setSelectedId(attachToAgentId);
          return;
        } catch (edgeErr) {
          setError(
            edgeErr instanceof ApiError
              ? `${preset.name} was created, but couldn't attach it automatically: ${edgeErr.message}`
              : `${preset.name} was created, but couldn't attach it automatically.`
          );
        }
      }
      setSelectedId(node.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not add tool preset");
    }
  }

  async function handleAddEnvironment(pos?: { x: number; y: number }) {
    try {
      const offset = nodes.length * 40;
      const node = await createEnvironmentNode(project.id, {
        position_x: pos?.x ?? 120 + offset,
        position_y: pos?.y ?? 100 + offset,
      });
      setNodes((n) => dedupeById([...n, node]));
      setSelectedId(node.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not provision environment");
    }
  }

  function handleToolCreated(node: ProjectNode, edge?: Edge) {
    setNodes((n) => dedupeById([...n, node]));
    if (edge) {
      setEdges((es) => dedupeById([...es, edge]));
      setSelectedId(edge.target_node_id);
    } else {
      setSelectedId(node.id);
    }
    setToolModal(null);
  }

  // Fired when a palette card is dropped directly on an agent's own card —
  // the design's "drop a tool on top of a card to equip it" gesture. Tool
  // types still collect config through the modal; presets (which already
  // carry their config) attach immediately, no modal, matching the design.
  function handleDropOnAgent(agent: ProjectNode, raw: string) {
    const [dragKind, slug] = raw.split(":");
    if (dragKind === "tool") {
      openToolConfig(slug, posNearAgent(agent), agent.id);
    } else if (dragKind === "preset") {
      handleAddPreset(slug, posNearAgent(agent), agent.id);
    }
  }

  // Each node kind has its own patch route (API.md's "Where to patch it"
  // table): agents use the generic /nodes/{id} route, environments have
  // their own /environments/{id} route, and — as of today's API — tool
  // nodes have no patch route at all, so a tool's position never round-trips
  // to the backend (it'll snap back to its last saved spot on reload). This
  // is the single place that decides which route a position save takes, so
  // dragging any node kind can't accidentally hit the wrong one again.
  async function savePosition(node: ProjectNode, x: number, y: number) {
    if (isEnvironmentNode(node)) {
      await updateEnvironment(project.id, node.id, { position_x: x, position_y: y });
    } else if (isToolNode(node)) {
      return; // no patch route for tool nodes yet — nothing to save
    } else {
      await updateNode(project.id, node.id, { position_x: x, position_y: y });
    }
  }

  async function handleDragEnd(node: ProjectNode, x: number, y: number) {
    setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, position_x: x, position_y: y } : n)));
    try {
      await savePosition(node, x, y);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save position");
    }
  }

  async function handleDeleteNode(node: ProjectNode) {
    try {
      await deleteNode(project.id, node.id);
      setNodes((prev) => prev.filter((n) => n.id !== node.id));
      setEdges((prev) => prev.filter((e) => e.source_node_id !== node.id && e.target_node_id !== node.id));
      setSelectedId((sel) => (sel === node.id ? null : sel));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete node");
    }
  }

  function handlePortDown(node: ProjectNode, side: "in" | "out") {
    const x = (node.position_x ?? 0) + (side === "out" ? 240 : 0);
    const y = (node.position_y ?? 0) + 32;
    setLink({ fromId: node.id, side, cursor: { x, y } });
  }

  function edgeKindFor(source: ProjectNode, target: ProjectNode): EdgeKind | null {
    if (isAgentNode(source) && isAgentNode(target)) return "context";
    if (isToolNode(source) && isAgentNode(target)) return "tool";
    if (isEnvironmentNode(source) && isAgentNode(target)) return "environment";
    return null;
  }

  function completeLink(targetId: string) {
    setLink((current) => {
      if (!current) return null;
      const dragNode = nodes.find((n) => n.id === current.fromId);
      const targetNode = nodes.find((n) => n.id === targetId);
      if (dragNode && targetNode && dragNode.id !== targetNode.id) {
        const source = current.side === "out" ? dragNode : targetNode;
        const target = current.side === "out" ? targetNode : dragNode;
        const kind = edgeKindFor(source, target);
        if (!kind) {
          setError(
            "That link isn't supported — tools and environments can only connect to agents, and agents only share context with other agents."
          );
        } else if (
          edges.some(
            (e) => e.source_node_id === source.id && e.target_node_id === target.id && e.kind === kind
          )
        ) {
          setError(`${source.name} → ${target.name} is already linked.`);
        } else {
          createEdge(project.id, source.id, target.id, kind)
            .then((edge) => {
              setEdges((es) => dedupeById([...es, edge]));
              if (kind === "context") {
                setNotice(
                  `Linked ${source.name} → ${target.name}. It starts stale with no summary — click the pill on the link and hit refresh to actually pull ${source.name}'s context into ${target.name}.`
                );
              } else if (kind === "tool") {
                setNotice(`${source.name} is now equipped on ${target.name} — see the chip on its card.`);
                setSelectedId(target.id);
              }
            })
            .catch((e) => setError(e instanceof ApiError ? e.message : "Could not create link"));
        }
      }
      return null;
    });
  }

  async function handleRefreshEdge(edge: Edge) {
    setRefreshingEdgeId(edge.id);
    try {
      const updated = await refreshEdge(project.id, edge.id);
      setEdges((es) => es.map((e) => (e.id === updated.id ? updated : e)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not refresh link");
    } finally {
      setRefreshingEdgeId(null);
    }
  }

  async function handleDeleteEdge(edge: Edge) {
    try {
      await deleteEdge(project.id, edge.id);
      setEdges((es) => es.filter((e) => e.id !== edge.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not remove link");
    }
  }

  // Unequipping a tool chip removes the `tool` edge (the node itself stays,
  // so it isn't lost) and nudges the now-detached tool node back into view
  // near the agent it just left, since it no longer has a card position of
  // its own once it's re-rendered as a standalone card.
  async function handleUnequipTool(edge: Edge) {
    try {
      await deleteEdge(project.id, edge.id);
      setEdges((es) => es.filter((e) => e.id !== edge.id));
      const agent = nodes.find((n) => n.id === edge.target_node_id);
      const tool = nodes.find((n) => n.id === edge.source_node_id);
      if (agent && tool) {
        const { x, y } = posNearAgent(agent);
        // Optimistic only — tool nodes have no patch route today (see
        // savePosition), so this position lives client-side for the
        // session and reverts to wherever it was created on next reload.
        setNodes((ns) => ns.map((n) => (n.id === tool.id ? { ...n, position_x: x, position_y: y } : n)));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not unequip tool");
    }
  }

  async function handleUpdateAgentPolicy(nodeId: string, policy: ToolPolicy) {
    try {
      const updated = await updateNode(project.id, nodeId, { tool_policy: policy });
      setNodes((ns) => ns.map((n) => (n.id === updated.id ? updated : n)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update tool policy");
    }
  }

  function handleNodeUpdated(updated: ProjectNode) {
    setNodes((ns) => ns.map((n) => (n.id === updated.id ? updated : n)));
  }

  function handleChatChange(nodeId: string, updater: (prev: ChatState) => ChatState) {
    setChatByNode((prev) => ({ ...prev, [nodeId]: updater(prev[nodeId] ?? defaultChatState()) }));
  }

  async function handleTidy() {
    const laidOut = nodes.map((n, i) => ({
      ...n,
      position_x: 110 + (i % 3) * 330,
      position_y: 80 + Math.floor(i / 3) * 220,
    }));
    setNodes(laidOut);
    for (const n of laidOut) {
      try {
        await savePosition(n, n.position_x ?? 0, n.position_y ?? 0);
      } catch {
        // best-effort — a single failed save shouldn't block the rest
      }
    }
  }

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  // Tool nodes that carry an outbound `tool` edge are "equipped" — they
  // render as a chip on the target agent's card instead of a floating box
  // of their own, per the design. Build that lookup once per render.
  const attachedToolsByAgent = new Map<string, AttachedTool[]>();
  const attachedToolNodeIds = new Set<string>();
  const environmentCountByAgent = new Map<string, number>();
  for (const e of edges) {
    if (e.kind === "tool") {
      const tool = nodes.find((n) => n.id === e.source_node_id);
      if (tool && isToolNode(tool)) {
        attachedToolNodeIds.add(tool.id);
        const list = attachedToolsByAgent.get(e.target_node_id) ?? [];
        list.push({ edge: e, tool });
        attachedToolsByAgent.set(e.target_node_id, list);
      }
    } else if (e.kind === "environment") {
      environmentCountByAgent.set(e.target_node_id, (environmentCountByAgent.get(e.target_node_id) ?? 0) + 1);
    }
  }

  const visibleNodes = nodes.filter((n) => !(isToolNode(n) && attachedToolNodeIds.has(n.id)));

  const toolNodeCount = nodes.filter(isToolNode).length;
  const agentNodeCount = nodes.filter(isAgentNode).length;
  const environmentNodeCount = nodes.filter(isEnvironmentNode).length;
  const equippedToolCount = attachedToolNodeIds.size;

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      <header className="flex items-center gap-4 px-5 h-14 border-b border-border shrink-0">
        <button onClick={onBack} className="text-xs text-muted hover:text-text">
          ← Projects
        </button>
        <div className="text-sm font-medium">{project.name}</div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-[10px] text-muted whitespace-nowrap">
            {agentNodeCount} agent{agentNodeCount === 1 ? "" : "s"} · {equippedToolCount} equipped tool
            {equippedToolCount === 1 ? "" : "s"} · {toolNodeCount - equippedToolCount} unattached · {environmentNodeCount}{" "}
            environment{environmentNodeCount === 1 ? "" : "s"} · {edges.length} link{edges.length === 1 ? "" : "s"}
          </div>
          <button
            onClick={handleTidy}
            className="text-xs text-muted hover:text-text border border-border rounded-md px-3 py-1.5"
          >
            ⌗ Tidy
          </button>
        </div>
      </header>

      <Palette
        tab={paletteTab}
        onTabChange={setPaletteTab}
        agentTypes={agentTypes}
        toolTypes={toolTypes}
        toolPresets={toolPresets}
        onAddAgent={(slug) => handleAddAgent(slug)}
        onAddTool={(slug) => openToolConfig(slug)}
        onAddPreset={(slug) => handleAddPreset(slug)}
        onAddEnvironment={() => handleAddEnvironment()}
      />

      {notice && (
        <div className="px-5 py-2 text-xs text-accent border-b border-border bg-accent/5 flex items-center gap-3">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-accent/70 hover:text-accent">
            dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="px-5 py-2 text-xs text-red-400 border-b border-border flex items-center gap-3">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200">
            dismiss
          </button>
        </div>
      )}

      <div className="px-5 py-1.5 border-b border-border text-[10px] text-muted flex flex-wrap gap-4">
        <span>Drag an agent, tool or environment card onto the canvas to add it</span>
        <span>Drop a tool onto an agent card to equip it — it shows up as a chip</span>
        <span>Drag from a node&apos;s ◗ port onto another node to link them</span>
        <span>Click a node&apos;s × to remove it</span>
      </div>

      <div className="flex-1 flex min-h-0">
        <main
          ref={canvasRef}
          className="flex-1 relative overflow-auto"
          style={{
            backgroundImage: "radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            cursor: link ? "crosshair" : "default",
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const raw = e.dataTransfer.getData("text/plain");
            const [kind, slug] = raw.split(":");
            const pos = relPos(e);
            if (kind === "agent") handleAddAgent(slug, pos);
            else if (kind === "tool") openToolConfig(slug, pos);
            else if (kind === "preset") handleAddPreset(slug, pos);
            else if (kind === "environment") handleAddEnvironment(pos);
          }}
          onPointerMove={(e) => {
            if (link) setLink((l) => (l ? { ...l, cursor: relPos(e) } : l));
          }}
          onPointerUp={() => setLink(null)}
          onClick={(e) => {
            if (e.target === canvasRef.current) setSelectedId(null);
          }}
        >
          <div style={{ position: "relative", width: LAYER_W, height: LAYER_H }}>
            <EdgeLayer
              nodes={nodes}
              edges={edges}
              selectedId={selectedId}
              link={link}
              refreshingId={refreshingEdgeId}
              onRefresh={handleRefreshEdge}
              onDelete={handleDeleteEdge}
            />
            {visibleNodes.map((node) => {
              const inboundCount = edges.filter(
                (e) => e.target_node_id === node.id && e.kind === "context"
              ).length;
              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  selected={node.id === selectedId}
                  linking={!!link}
                  linkHover={!!link && hoverNodeId === node.id && link.fromId !== node.id}
                  attachedTools={isAgentNode(node) ? attachedToolsByAgent.get(node.id) ?? [] : undefined}
                  environmentCount={isAgentNode(node) ? environmentCountByAgent.get(node.id) ?? 0 : undefined}
                  inboundCount={inboundCount}
                  onSelect={() => setSelectedId(node.id)}
                  onDragEnd={(x, y) => handleDragEnd(node, x, y)}
                  onDelete={() => handleDeleteNode(node)}
                  onPortDown={(side) => handlePortDown(node, side)}
                  onCardPointerUp={() => completeLink(node.id)}
                  onHoverChange={(hovering) => setHoverNodeId(hovering ? node.id : null)}
                  onDropOnCard={isAgentNode(node) ? (raw) => handleDropOnAgent(node, raw) : undefined}
                  onChipClick={(toolNodeId) => setSelectedId(toolNodeId)}
                  onChipRemove={(edge) => handleUnequipTool(edge)}
                />
              );
            })}
            {visibleNodes.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
                Drag an agent from the palette above to get started.
              </div>
            )}
          </div>
        </main>

        <Inspector
          projectId={project.id}
          node={selectedNode}
          nodes={nodes}
          edges={edges}
          toolTypes={toolTypes}
          chat={selectedNode ? chatByNode[selectedNode.id] ?? defaultChatState() : defaultChatState()}
          onChatChange={handleChatChange}
          onUpdateAgentPolicy={handleUpdateAgentPolicy}
          onRefreshEdge={handleRefreshEdge}
          onDeleteEdge={handleDeleteEdge}
          onUnequipTool={handleUnequipTool}
          onNodeUpdated={handleNodeUpdated}
          onAfterTurn={reloadCanvas}
        />
      </div>

      {toolModal && (
        <ToolConfigModal
          projectId={project.id}
          toolType={toolModal.toolType}
          position={toolModal.position}
          attachToAgentId={toolModal.attachToAgentId}
          onCreated={handleToolCreated}
          onCancel={() => setToolModal(null)}
        />
      )}
    </div>
  );
}
