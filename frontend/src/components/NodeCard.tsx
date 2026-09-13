"use client";

import { ProjectNode, isAgentNode } from "@/lib/types";

const AGENT_ICONS: Record<string, string> = {
  market_research: "◈",
  project_scoping: "◇",
  coding: "⌗",
};

const TOOL_ICONS: Record<string, string> = {
  brave_search: "◎",
  skill: "❖",
  mcp_server: "⌬",
  github: "⌗",
  obsidian: "▤",
  gmail: "✉",
};

export default function NodeCard({
  node,
  selected,
  linking,
  linkHover,
  toolCount,
  inboundCount,
  onSelect,
  onDragEnd,
  onDelete,
  onPortDown,
  onCardPointerUp,
  onHoverChange,
}: {
  node: ProjectNode;
  selected: boolean;
  linking: boolean;
  linkHover: boolean;
  toolCount?: number;
  inboundCount?: number;
  onSelect: () => void;
  onDragEnd: (x: number, y: number) => void;
  onDelete: () => void;
  onPortDown: (side: "in" | "out") => void;
  onCardPointerUp: () => void;
  onHoverChange: (hovering: boolean) => void;
}) {
  const agent = isAgentNode(node);
  const icon = agent
    ? AGENT_ICONS[node.agent_slug] ?? "◆"
    : TOOL_ICONS[node.tool_slug] ?? "◆";

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("[data-port],[data-btn]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = node.position_x ?? 0;
    const originY = node.position_y ?? 0;
    let latestX = originX;
    let latestY = originY;

    const card = e.currentTarget;

    function onMove(ev: PointerEvent) {
      latestX = originX + (ev.clientX - startX);
      latestY = originY + (ev.clientY - startY);
      card.style.left = `${latestX}px`;
      card.style.top = `${latestY}px`;
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // One PATCH per gesture on release, per API.md's guidance — not per
      // pixel while dragging.
      onDragEnd(latestX, latestY);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    onSelect();
  }

  const borderColor = linkHover
    ? "border-green"
    : selected
    ? "border-accent"
    : "border-border";

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerUp={onCardPointerUp}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      style={{ left: node.position_x ?? 0, top: node.position_y ?? 0, zIndex: selected ? 5 : 2 }}
      className={`absolute w-60 cursor-grab active:cursor-grabbing bg-panel border rounded-lg p-3 select-none ${borderColor}`}
    >
      {/* in port: agent nodes only, since only agents can be an edge target */}
      {agent && (
        <div
          data-port="in"
          onPointerDown={(e) => {
            e.stopPropagation();
            onPortDown("in");
          }}
          title="Receive context"
          className={`absolute -left-[7px] top-[26px] w-3.5 h-3.5 rounded-full bg-panel2 cursor-crosshair border-2 ${
            (inboundCount ?? 0) > 0 ? "border-accent" : "border-white/30"
          }`}
        />
      )}
      {/* out port: any node can be an edge source */}
      <div
        data-port="out"
        onPointerDown={(e) => {
          e.stopPropagation();
          onPortDown("out");
        }}
        title={agent ? "Share context" : "Attach this tool to an agent"}
        className="absolute -right-2 top-[24px] w-4 h-4 rounded-full bg-accent border-2 border-panel2 cursor-crosshair shadow-[0_0_10px_rgba(34,224,240,0.5)]"
      />

      <div className="flex items-start gap-2.5">
        <div
          className={`shrink-0 w-7 h-7 rounded-md border grid place-items-center text-sm ${
            selected ? "border-accent text-accent" : "border-white/20 text-white/60"
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{node.name}</div>
          <div className="text-[10px] text-muted truncate">
            {agent ? node.agent_slug : node.tool_slug}
          </div>
        </div>
        <button
          data-btn
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={agent ? "Delete agent" : "Delete tool"}
          className="shrink-0 text-white/30 hover:text-white/70 text-sm px-0.5"
        >
          ×
        </button>
      </div>

      {agent ? (
        <div className="mt-2.5 pt-2.5 border-t border-border flex items-center gap-2 text-[10px] text-muted">
          <span>Tool policy: <span className="text-text/70">{node.tool_policy}</span></span>
          {typeof toolCount === "number" && (
            <span className="ml-auto">{toolCount} tool{toolCount === 1 ? "" : "s"}</span>
          )}
        </div>
      ) : (
        <div className="mt-2.5 pt-2.5 border-t border-border flex items-center gap-2 text-[10px]">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              node.status === "ready"
                ? "bg-green"
                : node.status === "error"
                ? "bg-red-400"
                : "bg-white/30"
            }`}
          />
          <span className="text-muted uppercase tracking-wide">{node.status}</span>
          {node.status_detail && (
            <span className="ml-1 truncate text-muted/80" title={node.status_detail}>
              — {node.status_detail}
            </span>
          )}
        </div>
      )}

      {linking && !linkHover && (
        <div className="absolute inset-0 rounded-lg pointer-events-none border border-dashed border-white/10" />
      )}
    </div>
  );
}
