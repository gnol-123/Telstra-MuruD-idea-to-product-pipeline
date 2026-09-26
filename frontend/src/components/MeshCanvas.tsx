"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import Palette, { PaletteTab, PaletteTabs } from "./Palette";
import NodeCard, { AttachedTool, AttachedEnvironment } from "./NodeCard";
import EdgeLayer, { LinkDraft, LAYER_W, LAYER_H, portOf } from "./EdgeLayer";
import Inspector from "./Inspector";
import ChatWindow, { ChatState, defaultChatState } from "./ChatWindow";
import ToolConfigModal from "./ToolConfigModal";
import WorkspaceWindow from "./workspace/WorkspaceWindow";
import { BrandMark } from "./Brand";

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
  // True until the first load has everything the canvas needs. Nodes and
  // edges used to be set from two independent requests, so whichever one
  // resolved first painted its cards with no lines to connect them for a
  // beat — the "every node opens disconnected" bug. Gating the first paint
  // on all of it landing together fixes that at the source.
  const [initialLoading, setInitialLoading] = useState(true);
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
  // Keyed by agent node id — kept here, above the chat window, so an
  // in-flight turn keeps streaming into state even after the window is
  // closed, and reopening shows it without re-fetching. The backend
  // transcript is fetched once per node on first open (see ChatWindow).
  const [chatByNode, setChatByNode] = useState<Record<string, ChatState>>({});
  // Which agent's chat window is open, if any.
  const [chatNodeId, setChatNodeId] = useState<string | null>(null);
  // The code preview: which environment, and which folder to reveal.
  const [workspace, setWorkspace] = useState<{ envId: string; path: string | null } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pinchDist = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  // In-flight create/delete calls. Non-zero means the server list is behind
  // the UI, so the poll merges status only and skips add/remove.
  const pendingMutations = useRef(0);
  // Same idea for the tool modal: its create call lives inside the modal.
  const toolModalOpen = useRef(false);
  // Ticks once per completed mutation, so a poll can detect one landed while
  // its own request was in flight.
  const mutationSeq = useRef(0);
  // Nodes with a delete in flight. Spinner until the row actually goes.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  // Live position of the node being dragged, null when nothing is.
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  // Same fact as dragPos, as a ref the poll's closure can read live.
  const draggingRef = useRef(false);

  async function reloadCanvas() {
    try {
      const [ns, es] = await Promise.all([listNodes(project.id), listEdges(project.id)]);
      setNodes(dedupeById(ns));
      setEdges(dedupeById(es));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not refresh the canvas");
    }
  }

  // Holds off the poll's add/remove while a create or delete is mid-flight.
  async function mutating<T>(fn: () => Promise<T>): Promise<T> {
    pendingMutations.current += 1;
    try {
      return await fn();
    } finally {
      pendingMutations.current -= 1;
      // Bumped on completion so an in-flight poll can tell its response
      // predates this change and skip adding from it.
      mutationSeq.current += 1;
    }
  }

  function markDeleting(nodeId: string, on: boolean) {
    setDeletingIds((prev) => {
      if (prev.has(nodeId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    setInitialLoading(true);
    Promise.all([getAgentTypes(), getToolTypes(), getToolPresets(), listNodes(project.id), listEdges(project.id)])
      .then(([ats, tts, presets, ns, es]) => {
        if (cancelled) return;
        setAgentTypes(ats);
        setToolTypes(tts);
        setToolPresets(presets);
        // Nodes and edges are applied in the same tick, so the canvas never
        // paints a card before the line that connects it.
        setNodes(dedupeById(ns));
        setEdges(dedupeById(es));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Could not load this project");
      })
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Per the teammate's node-status addition: every node row (agent, tool,
  // environment) now carries status/status_detail (see NodeResponse in
  // routers/projects.py). Poll nodes and edges every 2s so server-side
  // creates (orchestrator provisioning) and deletes land on the canvas.
  // Merge rules: known nodes take status/status_detail/name only, never
  // position, which a drag owns locally until release. Unknown nodes are
  // added whole. Missing nodes are removed, but only from a non-empty
  // response with no mutation in flight, so a dropped request or a
  // mid-create tick can't wipe the canvas. setState is skipped entirely
  // when nothing actually changed.
  useEffect(() => {
    const interval = setInterval(() => {
      // Counted when the request goes out, compared when it comes back. A
      // response that overlapped a create or delete describes a canvas from
      // before it, so adding from it resurrects nodes the server just
      // removed: they sit there until the next tick, and every call against
      // them 404s.
      const startedAt = mutationSeq.current;
      const startedInFlight = pendingMutations.current;
      Promise.all([listNodes(project.id), listEdges(project.id)])
        .then(([fresh, freshEdges]) => {
          // A drag is a gesture in progress: adding or removing cards under
          // the cursor stutters it, so leave the canvas alone until release.
          if (draggingRef.current) return;
          const settled =
            pendingMutations.current === 0 &&
            startedInFlight === 0 &&
            mutationSeq.current === startedAt &&
            !toolModalOpen.current;
          const byId = new Map(fresh.map((n) => [n.id, n]));
          setNodes((prev) => {
            let changed = false;
            const merged = prev.flatMap((n) => {
              const f = byId.get(n.id);
              if (!f) {
                if (!settled || fresh.length === 0) return [n];
                changed = true;
                return [];
              }
              const cur = n as ProjectNode & { status?: string };
              const fs = f as ProjectNode & { status?: string };
              if (cur.status === fs.status && n.status_detail === f.status_detail && n.name === f.name) {
                return [n];
              }
              changed = true;
              return [{ ...n, status: fs.status, status_detail: f.status_detail, name: f.name } as ProjectNode];
            });
            if (settled) {
              const known = new Set(prev.map((n) => n.id));
              // A tool/environment arrives hidden if this same response says
              // it is equipped. Adding it before its edge lands would flash
              // it as a floating box for one tick.
              const added = fresh.filter((n) => !known.has(n.id));
              if (added.length > 0) {
                changed = true;
                return dedupeById([...merged, ...added]);
              }
            }
            return changed ? merged : prev;
          });
          // Don't leave the inspector on a node the poll just removed.
          if (settled && fresh.length > 0) {
            setSelectedId((sel) => (sel && !byId.has(sel) ? null : sel));
          }
          // Nothing edits an edge locally, so replacing wholesale is safe.
          // Only while settled: nodes and edges are two separate requests, so
          // an unsettled tick can pair stale nodes with fresh edges and flash
          // an equipped tool as a floating box.
          if (!settled) return;
          setEdges((prev) => {
            const next = dedupeById(freshEdges);
            if (prev.length === next.length && prev.every((e, i) => e.id === next[i].id)) return prev;
            return next;
          });
        })
        .catch(() => {
          // Best-effort: a failed poll just tries again on the next tick.
        });
    }, 2000);
    return () => clearInterval(interval);
  }, [project.id]);

  // Notices are informational — let them fade on their own. Errors stay
  // until dismissed so they can't be missed.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(t);
  }, [notice]);

  // Esc abandons a half-drawn link (the chat window handles its own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLink(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Zoom keeping the canvas point under (clientX, clientY) fixed.
  function zoomAt(next: number, clientX: number, clientY: number) {
    const c = canvasRef.current;
    if (!c) return;
    next = Math.min(2, Math.max(0.3, next));
    const r = c.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const wx = (px + c.scrollLeft) / zoomRef.current;
    const wy = (py + c.scrollTop) / zoomRef.current;
    zoomRef.current = next;
    // Layout must grow before scroll can be set past the old extent.
    flushSync(() => setZoom(next));
    c.scrollLeft = wx * next - px;
    c.scrollTop = wy * next - py;
  }

  function zoomCenter(next: number) {
    const r = canvasRef.current?.getBoundingClientRect();
    if (r) zoomAt(next, r.left + r.width / 2, r.top + r.height / 2);
  }

  // ctrl/cmd+wheel (and trackpad pinch) zooms; needs a non-passive listener.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, []);

  // Two-finger pinch zooms; one finger is left to cards/ports (canvas is touch-none).
  function handleTouchMove(e: React.TouchEvent) {
    if (e.touches.length !== 2) {
      pinchDist.current = null;
      return;
    }
    const [a, b] = [e.touches[0], e.touches[1]];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const prev = pinchDist.current;
    if (prev) zoomAt(zoomRef.current * (dist / prev), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    else setLink(null);
    pinchDist.current = dist;
  }

  function relPos(e: { clientX: number; clientY: number }) {
    const c = canvasRef.current;
    if (!c) return { x: e.clientX, y: e.clientY };
    const r = c.getBoundingClientRect();
    const z = zoomRef.current;
    return { x: (e.clientX - r.left + c.scrollLeft) / z, y: (e.clientY - r.top + c.scrollTop) / z };
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
      const node = await mutating(() =>
        createAgentNode(project.id, agentSlug, {
          position_x: pos?.x ?? 120 + offset,
          position_y: pos?.y ?? 100 + offset,
        })
      );
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
    toolModalOpen.current = true;
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
      const node = await mutating(() =>
        createToolNode(project.id, {
          presetSlug: preset.slug,
          name: preset.name,
          position_x: position.x,
          position_y: position.y,
        })
      );
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
      const node = await mutating(() =>
        createEnvironmentNode(project.id, {
          position_x: pos?.x ?? 120 + offset,
          position_y: pos?.y ?? 100 + offset,
        })
      );
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
    toolModalOpen.current = false;
    // The modal created a node, so polls already in flight are stale.
    mutationSeq.current += 1;
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

  // Live position during a drag. No save; edges re-render off this.
  // One small state for the node under the cursor, instead of rewriting the
  // whole nodes array on every pointermove. Edges still follow, because
  // positionsFor() overlays this before anything reads a position.
  function handleDragMove(node: ProjectNode, x: number, y: number) {
    draggingRef.current = true;
    setDragPos({ id: node.id, x, y });
  }

  async function handleDragEnd(node: ProjectNode, x: number, y: number) {
    draggingRef.current = false;
    setDragPos(null);
    setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, position_x: x, position_y: y } : n)));
    try {
      await savePosition(node, x, y);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save position");
    }
  }

  async function handleDeleteNode(node: ProjectNode) {
    if (deletingIds.has(node.id)) return;
    markDeleting(node.id, true);
    try {
      const { deleted_node_ids } = await mutating(() => deleteNode(project.id, node.id));
      const gone = new Set(deleted_node_ids ?? [node.id]);
      setNodes((prev) => prev.filter((n) => !gone.has(n.id)));
      setEdges((prev) => prev.filter((e) => !gone.has(e.source_node_id) && !gone.has(e.target_node_id)));
      setSelectedId((sel) => (sel && gone.has(sel) ? null : sel));
      setChatNodeId((c) => (c && gone.has(c) ? null : c));
      setWorkspace((w) => (w && gone.has(w.envId) ? null : w));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete node");
    } finally {
      // Clears the spinner on failure; on success the node is already gone.
      markDeleting(node.id, false);
    }
  }

  function handlePortDown(node: ProjectNode, side: "in" | "out") {
    setLink({ fromId: node.id, side, cursor: portOf(node, side) });
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

  // Refresh every stale inbound context link on an agent at once — the
  // card's ⟳ button and the inspector's "Clear stale context" both use it.
  async function clearStaleFor(nodeId: string) {
    const stale = edges.filter((e) => e.kind === "context" && e.target_node_id === nodeId && e.is_stale);
    await Promise.all(stale.map((e) => handleRefreshEdge(e)));
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
  const attachedEnvsByAgent = new Map<string, AttachedEnvironment[]>();
  const attachedToolNodeIds = new Set<string>();
  const attachedEnvNodeIds = new Set<string>();
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
      const env = nodes.find((n) => n.id === e.source_node_id);
      if (env && isEnvironmentNode(env)) {
        attachedEnvNodeIds.add(env.id);
        const list = attachedEnvsByAgent.get(e.target_node_id) ?? [];
        list.push({ edge: e, env });
        attachedEnvsByAgent.set(e.target_node_id, list);
      }
    }
  }

  // The dragging node's live position, overlaid on the one node it applies
  // to. Cards and EdgeLayer both read this, so edges track the drag without
  // rebuilding the whole array on every pointermove.
  const positioned = dragPos
    ? nodes.map((n) =>
        n.id === dragPos.id ? { ...n, position_x: dragPos.x, position_y: dragPos.y } : n
      )
    : nodes;

  const visibleNodes = positioned.filter(
    (n) =>
      !(isToolNode(n) && attachedToolNodeIds.has(n.id)) &&
      !(isEnvironmentNode(n) && attachedEnvNodeIds.has(n.id))
  );

  const toolNodeCount = nodes.filter(isToolNode).length;
  const agentNodeCount = nodes.filter(isAgentNode).length;
  const environmentNodeCount = nodes.filter(isEnvironmentNode).length;
  const equippedToolCount = attachedToolNodeIds.size;
  const contextLinkCount = edges.filter((e) => e.kind === "context").length;

  const chatNode = nodes.find((n) => n.id === chatNodeId);
  const openChat = (id: string) => {
    setSelectedId(id);
    setChatNodeId(id);
  };

  const envNodes = nodes.filter(isEnvironmentNode);
  // The environment the header's Workspace button opens: the selected one,
  // else the first one the selected agent uses, else a user environment,
  // else the shared scratch space every agent writes to.
  function defaultWorkspace(): { envId: string; path: string | null } | null {
    if (selectedNode && isEnvironmentNode(selectedNode)) return { envId: selectedNode.id, path: null };
    if (selectedNode && isAgentNode(selectedNode)) {
      const e = edges.find((x) => x.kind === "environment" && x.target_node_id === selectedNode.id);
      if (e) return { envId: e.source_node_id, path: `/home/user/workspace/${selectedNode.id}` };
    }
    const env = envNodes.find((n) => n.role !== "scratch") ?? envNodes[0];
    return env ? { envId: env.id, path: null } : null;
  }
  const openWorkspace = (envId: string, path?: string | null) => setWorkspace({ envId, path: path ?? null });

  // Nothing paints — not even an empty canvas — until nodes, edges and the
  // library lists have all landed together (see the mount effect above).
  if (initialLoading) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-5 bg-bg text-text">
        <div className="relative w-14 h-14 grid place-items-center">
          <div className="opacity-90">
            <BrandMark size={34} />
          </div>
          <div className="absolute inset-0 rounded-full border-2 border-white/10 border-t-accent animate-spin" />
        </div>
        <div className="text-[13px] text-white/50">Loading {project.name}…</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-bg text-text select-none">
      <header className="flex-none flex items-center gap-[22px] px-5 h-[60px] border-b border-white/[0.09] z-[5]">
        <div className="flex items-center gap-3 flex-none min-w-0">
          <button
            onClick={onBack}
            title="Back to projects"
            className="w-7 h-7 rounded-lg border border-white/[0.12] text-white/50 hover:text-text hover:border-white/30 text-sm grid place-items-center"
          >
            ‹
          </button>
          <BrandMark />
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-[-0.01em]">Agent Mesh</div>
            <div className="text-[10.5px] text-white/[0.38] truncate max-w-[200px]" title={project.name}>
              {project.name}
            </div>
          </div>
        </div>

        <PaletteTabs tab={paletteTab} onTabChange={setPaletteTab} />

        <div className="ml-auto flex items-center gap-2.5">
          <div
            className="hidden lg:flex items-center gap-[7px] px-[11px] py-1.5 border border-white/10 rounded-lg text-[11.5px] text-white/50 whitespace-nowrap"
            title={`${equippedToolCount} equipped · ${toolNodeCount - equippedToolCount} unattached tool node(s)`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-green anim-softpulse" />
            {agentNodeCount} agent{agentNodeCount === 1 ? "" : "s"} · {contextLinkCount} link
            {contextLinkCount === 1 ? "" : "s"} · {equippedToolCount} tool{equippedToolCount === 1 ? "" : "s"} ·{" "}
            {environmentNodeCount} env{environmentNodeCount === 1 ? "" : "s"}
          </div>
          <button
            onClick={() => {
              const w = defaultWorkspace();
              if (w) setWorkspace(w);
            }}
            disabled={envNodes.length === 0}
            title={
              envNodes.length === 0
                ? "No environment yet — add an agent or an environment first"
                : "Browse what agents have built, download it, and preview it running"
            }
            className="border border-green/35 text-green hover:bg-green/10 rounded-lg px-3 py-2 text-xs transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            ▣ Workspace
          </button>
          <button
            onClick={handleTidy}
            className="bg-transparent border border-white/[0.14] text-white/60 hover:text-text hover:border-white/30 rounded-lg px-3 py-2 text-xs transition-colors"
          >
            ⌗ Tidy
          </button>
        </div>
      </header>

      <Palette
        tab={paletteTab}
        agentTypes={agentTypes}
        toolTypes={toolTypes}
        toolPresets={toolPresets}
        nodes={nodes}
        edges={edges}
        refreshingEdgeId={refreshingEdgeId}
        onAddAgent={(slug) => handleAddAgent(slug)}
        onAddTool={(slug) => openToolConfig(slug)}
        onAddPreset={(slug) => handleAddPreset(slug)}
        onAddEnvironment={() => handleAddEnvironment()}
        onRefreshEdge={handleRefreshEdge}
        onDeleteEdge={handleDeleteEdge}
      />

      <div className="flex-1 flex min-h-0 relative">
        {/* Toasts float over the canvas instead of pushing it down. */}
        {(notice || error) && (
          <div className="absolute top-3 left-5 right-[320px] z-20 flex flex-col items-center gap-2 pointer-events-none">
            {error && (
              <div className="pointer-events-auto max-w-2xl flex items-start gap-3 px-3.5 py-2.5 rounded-[9px] border border-red-400/40 bg-[#1a0b0c]/95 backdrop-blur text-xs text-red-300 shadow-[0_14px_34px_rgba(0,0,0,.5)] anim-pop">
                <span className="text-red-400">⚠</span>
                <span className="flex-1 leading-relaxed">{error}</span>
                <button onClick={() => setError(null)} className="text-red-300/60 hover:text-red-200">
                  ×
                </button>
              </div>
            )}
            {notice && (
              <div className="pointer-events-auto max-w-2xl flex items-start gap-3 px-3.5 py-2.5 rounded-[9px] border border-accent/30 bg-[#0E1B3A]/95 backdrop-blur text-xs text-accent shadow-[0_14px_34px_rgba(0,0,0,.5)] anim-pop">
                <span>◗</span>
                <span className="flex-1 leading-relaxed">{notice}</span>
                <button onClick={() => setNotice(null)} className="text-accent/60 hover:text-accent">
                  ×
                </button>
              </div>
            )}
          </div>
        )}

        <div className="absolute left-0 right-[300px] bottom-0 z-[4] flex flex-wrap gap-[18px] px-5 py-2 bg-panel border-t border-white/[0.08] text-[10.5px] text-white/[0.34] pointer-events-none">
          <span>Drag a card to move it</span>
          <span>Drag from ◗ port to port to share context</span>
          <span>Drop a tool onto a card to equip it</span>
          <span>Double-click an agent to chat</span>
        </div>

        <div className="absolute right-[316px] bottom-12 z-[4] flex items-center border border-white/[0.13] rounded-md bg-panel/80 text-[11px] text-white/60">
          <button onClick={() => zoomCenter(zoom / 1.2)} className="px-2 py-1 hover:text-white" title="Zoom out">−</button>
          <button onClick={() => zoomCenter(1)} className="px-1.5 py-1 w-12 hover:text-white" title="Reset zoom">{Math.round(zoom * 100)}%</button>
          <button onClick={() => zoomCenter(zoom * 1.2)} className="px-2 py-1 hover:text-white" title="Zoom in">+</button>
        </div>

        <main
          ref={canvasRef}
          className="flex-1 min-w-0 relative overflow-auto touch-none pb-9"
          style={{
            backgroundColor: "#0A0F24",
            backgroundImage: "radial-gradient(rgba(255,255,255,.075) 1px, transparent 1px)",
            backgroundSize: "26px 26px",
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
          onTouchMove={handleTouchMove}
          onTouchEnd={() => (pinchDist.current = null)}
          onClick={(e) => {
            if (e.target === canvasRef.current || (e.target as HTMLElement).dataset.canvasLayer) setSelectedId(null);
          }}
        >
          <div data-canvas-layer="1" style={{ width: LAYER_W * zoom, height: LAYER_H * zoom }}>
          <div
            data-canvas-layer="1"
            style={{ position: "relative", width: LAYER_W, height: LAYER_H, transform: `scale(${zoom})`, transformOrigin: "0 0" }}
          >
            <EdgeLayer
              nodes={positioned}
              edges={edges.filter((e) => e.kind !== "environment")}
              selectedId={selectedId}
              link={link}
              refreshingId={refreshingEdgeId}
              onRefresh={handleRefreshEdge}
              onDelete={handleDeleteEdge}
              onSelectNode={setSelectedId}
            />
            {visibleNodes.map((node) => {
              const inbound = edges.filter((e) => e.target_node_id === node.id && e.kind === "context");
              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  selected={node.id === selectedId}
                  linking={!!link}
                  linkHover={!!link && hoverNodeId === node.id && link.fromId !== node.id}
                  attachedTools={isAgentNode(node) ? attachedToolsByAgent.get(node.id) ?? [] : undefined}
                  inboundCount={inbound.length}
                  staleCount={inbound.filter((e) => e.is_stale).length}
                  busy={!!chatByNode[node.id]?.busy}
                  deleting={deletingIds.has(node.id)}
                  zoom={zoom}
                  attachedEnvironments={isAgentNode(node) ? attachedEnvsByAgent.get(node.id) ?? [] : undefined}
                  onSelect={() => setSelectedId(node.id)}
                  onDragMove={(x, y) => handleDragMove(node, x, y)}
                  onDragEnd={(x, y) => handleDragEnd(node, x, y)}
                  onDelete={() => handleDeleteNode(node)}
                  onPortDown={(side) => handlePortDown(node, side)}
                  onCardPointerUp={() => completeLink(node.id)}
                  onHoverChange={(hovering) => setHoverNodeId(hovering ? node.id : null)}
                  onDropOnCard={isAgentNode(node) ? (raw) => handleDropOnAgent(node, raw) : undefined}
                  onChipClick={(toolNodeId) => setSelectedId(toolNodeId)}
                  onChipRemove={(edge) => handleUnequipTool(edge)}
                  onClearStale={() => clearStaleFor(node.id)}
                  onOpenChat={isAgentNode(node) ? () => openChat(node.id) : undefined}
                  onOpenWorkspace={openWorkspace}
                />
              );
            })}
          </div>
          </div>
          {visibleNodes.length === 0 && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="text-center">
                <div className="mx-auto w-fit opacity-70">
                  <BrandMark size={40} />
                </div>
                <div className="mt-4 text-sm text-white/70">An empty mesh</div>
                <div className="mt-1 text-xs text-white/[0.38]">
                  Drag an agent from the library above — or click one — to get started.
                </div>
              </div>
            </div>
          )}
        </main>

        <Inspector
          projectId={project.id}
          node={selectedNode}
          nodes={nodes}
          edges={edges}
          toolTypes={toolTypes}
          chatBusy={!!(selectedNode && chatByNode[selectedNode.id]?.busy)}
          refreshingEdgeId={refreshingEdgeId}
          onOpenChat={openChat}
          onUpdateAgentPolicy={handleUpdateAgentPolicy}
          onRefreshEdge={handleRefreshEdge}
          onDeleteEdge={handleDeleteEdge}
          onUnequipTool={handleUnequipTool}
          onNodeUpdated={handleNodeUpdated}
          onOpenWorkspace={openWorkspace}
        />
      </div>

      {chatNode && isAgentNode(chatNode) && (
        <ChatWindow
          key={chatNode.id}
          projectId={project.id}
          node={chatNode}
          nodes={nodes}
          edges={edges}
          chat={chatByNode[chatNode.id] ?? defaultChatState()}
          onChatChange={(updater) => handleChatChange(chatNode.id, updater)}
          onClose={() => setChatNodeId(null)}
          onAfterTurn={reloadCanvas}
          onRefreshEdge={handleRefreshEdge}
          onOpenWorkspace={openWorkspace}
        />
      )}

      {workspace && envNodes.some((n) => n.id === workspace.envId) && (
        <WorkspaceWindow
          projectId={project.id}
          envs={envNodes}
          initialEnvId={workspace.envId}
          initialPath={workspace.path}
          nodes={nodes}
          onNodeUpdated={handleNodeUpdated}
          onClose={() => setWorkspace(null)}
        />
      )}

      {toolModal && (
        <ToolConfigModal
          projectId={project.id}
          toolType={toolModal.toolType}
          position={toolModal.position}
          attachToAgentId={toolModal.attachToAgentId}
          onCreated={handleToolCreated}
          onCancel={() => {
            toolModalOpen.current = false;
            setToolModal(null);
          }}
        />
      )}
    </div>
  );
}
