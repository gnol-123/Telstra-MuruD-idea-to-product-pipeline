"use client";

import { useEffect, useRef, useState } from "react";
import {
  Project,
  AgentType,
  ToolType,
  ProjectNode,
  Edge,
  EdgeKind,
  ToolPolicy,
  isAgentNode,
  isToolNode,
} from "@/lib/types";
import {
  getAgentTypes,
  getToolTypes,
  listNodes,
  createAgentNode,
  updateNode,
  deleteNode,
  listEdges,
  createEdge,
  refreshEdge,
  deleteEdge,
  ApiError,
} from "@/lib/api";
import Palette, { PaletteTab } from "./Palette";
import NodeCard from "./NodeCard";
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
}) {  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [toolTypes, setToolTypes] = useState<ToolType[]>([]);
  const [nodes, setNodes] = useState<ProjectNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paletteTab, setPaletteTab] = useState<PaletteTab>("agents");
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [refreshingEdgeId, setRefreshingEdgeId] = useState<string | null>(null);
  const [toolModal, setToolModal] = useState<{ toolType: ToolType; position: { x: number; y: number } } | null>(
    null
  );
  // Keyed by agent node id — kept here, above the Inspector, so a
  // conversation survives switching to another node and back. The API has
  // no endpoint to re-fetch a conversation's history (see API.md's "Not
  // implemented yet"), so this is the only copy of it once it's sent.
  const [chatByNode, setChatByNode] = useState<Record<string, ChatState>>({});
  const canvasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getAgentTypes().then(setAgentTypes).catch((e: ApiError) => setError(e.message));
    getToolTypes().then(setToolTypes).catch((e: ApiError) => setError(e.message));
    listNodes(project.id)
      .then((ns) => setNodes(dedupeById(ns)))
      .catch((e: ApiError) => setError(e.message));
    listEdges(project.id)
      .then((es) => setEdges(dedupeById(es)))
      .catch((e: ApiError) => setError(e.message));
  }, [project.id]);

  function relPos(e: { clientX: number; clientY: number }) {
    const c = canvasRef.current;
    if (!c) return { x: e.clientX, y: e.clientY };
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left + c.scrollLeft, y: e.clientY - r.top + c.scrollTop };
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
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not add agent");
    }
  }

  function openToolConfig(toolSlug: string, pos?: { x: number; y: number }) {
    const toolType = toolTypes.find((t) => t.slug === toolSlug);
    if (!toolType) return;
    const offset = nodes.length * 40;
    setToolModal({
      toolType,
      position: pos ?? { x: 120 + offset, y: 100 + offset },
    });
  }

  function handleToolCreated(node: ProjectNode) {
    setNodes((n) => dedupeById([...n, node]));
    setToolModal(null);
    setSelectedId(node.id);
  }

  async function handleDragEnd(node: ProjectNode, x: number, y: number) {
    setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, position_x: x, position_y: y } : n)));
    try {
      await updateNode(project.id, node.id, { position_x: x, position_y: y });
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
            "That link isn't supported — tools can only connect to agents, and agents only share context with other agents."
          );
        } else if (
          edges.some(
            (e) => e.source_node_id === source.id && e.target_node_id === target.id && e.kind === kind
          )
        ) {
          setError(`${source.name} → ${target.name} is already linked. Look for its pill on the canvas.`);
        } else {
          createEdge(project.id, source.id, target.id, kind)
            .then((edge) => {
              setEdges((es) => dedupeById([...es, edge]));
              if (kind === "context") {
                setNotice(
                  `Linked ${source.name} → ${target.name}. It starts stale with no summary — click the pill on the link and hit refresh to actually pull ${source.name}'s context into ${target.name}.`
                );
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
        await updateNode(project.id, n.id, { position_x: n.position_x, position_y: n.position_y });
      } catch {
        // best-effort — a single failed save shouldn't block the rest
      }
    }
  }

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const toolNodeCount = nodes.filter(isToolNode).length;
  const agentNodeCount = nodes.filter(isAgentNode).length;

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      <header className="flex items-center gap-4 px-5 h-14 border-b border-border shrink-0">
        <button onClick={onBack} className="text-xs text-muted hover:text-text">
          ← Projects
        </button>
        <div className="text-sm font-medium">{project.name}</div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-[10px] text-muted whitespace-nowrap">
            {agentNodeCount} agent{agentNodeCount === 1 ? "" : "s"} · {toolNodeCount} tool
            {toolNodeCount === 1 ? "" : "s"} · {edges.length} link{edges.length === 1 ? "" : "s"}
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
        onAddAgent={(slug) => handleAddAgent(slug)}
        onAddTool={(slug) => openToolConfig(slug)}
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
        <span>Drag an agent or tool card onto the canvas to add it</span>
        <span>Drag from a node&apos;s ◗ port onto another node to link them</span>
        <span>A new link starts stale — click its pill to pull in context</span>
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
            {nodes.map((node) => {
              const inboundCount = edges.filter(
                (e) => e.target_node_id === node.id && e.kind === "context"
              ).length;
              const toolCount = edges.filter(
                (e) => e.target_node_id === node.id && e.kind === "tool"
              ).length;
              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  selected={node.id === selectedId}
                  linking={!!link}
                  linkHover={!!link && hoverNodeId === node.id && link.fromId !== node.id}
                  toolCount={isAgentNode(node) ? toolCount : undefined}
                  inboundCount={inboundCount}
                  onSelect={() => setSelectedId(node.id)}
                  onDragEnd={(x, y) => handleDragEnd(node, x, y)}
                  onDelete={() => handleDeleteNode(node)}
                  onPortDown={(side) => handlePortDown(node, side)}
                  onCardPointerUp={() => completeLink(node.id)}
                  onHoverChange={(hovering) => setHoverNodeId(hovering ? node.id : null)}
                />
              );
            })}
            {nodes.length === 0 && (
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
          onNodeUpdated={handleNodeUpdated}
        />
      </div>

      {toolModal && (
        <ToolConfigModal
          projectId={project.id}
          toolType={toolModal.toolType}
          position={toolModal.position}
          onCreated={handleToolCreated}
          onCancel={() => setToolModal(null)}
        />
      )}
    </div>
  );
}
