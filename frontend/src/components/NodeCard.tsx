"use client";

import { useState } from "react";
import { Edge, ProjectNode, ToolNode, isAgentNode, isEnvironmentNode } from "@/lib/types";

export const AGENT_ICONS: Record<string, string> = {
  market_research: "◈",
  project_scoping: "◇",
  coding: "⌗",
  ux_ui: "✦",
  orchestrator: "❖",
};

export const TOOL_ICONS: Record<string, string> = {
  brave_search: "◎",
  web_fetch: "◍",
  context7: "▥",
  skill: "❖",
  mcp_server: "⌬",
  github: "⌗",
  obsidian: "▤",
  gmail: "✉",
};

export const ENV_ICON = "▣";

export interface AttachedTool {
  edge: Edge;
  tool: ToolNode;
}

export default function NodeCard({
  node,
  selected,
  linking,
  linkHover,
  attachedTools,
  environmentCount,
  inboundCount,
  onSelect,
  onDragEnd,
  onDelete,
  onPortDown,
  onCardPointerUp,
  onHoverChange,
  onDropOnCard,
  onChipClick,
  onChipRemove,
}: {
  node: ProjectNode;
  selected: boolean;
  linking: boolean;
  linkHover: boolean;
  // Agent nodes only: tool nodes attached via an inbound `tool` edge,
  // rendered as chips on the card itself rather than as separate boxes.
  attachedTools?: AttachedTool[];
  environmentCount?: number;
  inboundCount?: number;
  onSelect: () => void;
  onDragEnd: (x: number, y: number) => void;
  onDelete: () => void;
  onPortDown: (side: "in" | "out") => void;
  onCardPointerUp: () => void;
  onHoverChange: (hovering: boolean) => void;
  // Fires when something is dropped directly on this card — the raw
  // dataTransfer payload ("tool:<slug>" or "preset:<slug>") is handled by
  // the parent, which knows how to create + attach it.
  onDropOnCard?: (raw: string) => void;
  onChipClick?: (toolNodeId: string) => void;
  onChipRemove?: (edge: Edge) => void;
}) {
  const agent = isAgentNode(node);
  const env = isEnvironmentNode(node);
  // Native HTML5 drag-over state (a tool/preset card being dragged from the
  // palette), tracked separately from `linkHover` — that one is for the
  // pointer-based port-to-port linking gesture, a different drag system.
  const [nativeDragOver, setNativeDragOver] = useState(false);
  const icon = agent
    ? AGENT_ICONS[node.agent_slug] ?? "◆"
    : env
    ? ENV_ICON
    : TOOL_ICONS[(node as ToolNode).tool_slug] ?? "◆";

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("[data-port],[data-btn],[data-chip]")) return;
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

  // Two distinct "something is about to land on me" states, both shown as a
  // green border: a tool being dropped from the palette (native drag), or a
  // context/tool/environment port being dragged onto this card (pointer link).
  const dropHighlight = agent && nativeDragOver;
  const borderColor = dropHighlight || linkHover
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
      onDragOver={(e) => {
        if (!agent) return;
        e.preventDefault();
        e.stopPropagation();
        if (!nativeDragOver) setNativeDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!agent) return;
        e.stopPropagation();
        setNativeDragOver(false);
      }}
      onDrop={(e) => {
        if (!agent || !onDropOnCard) return;
        e.preventDefault();
        e.stopPropagation();
        setNativeDragOver(false);
        const raw = e.dataTransfer.getData("text/plain");
        onDropOnCard(raw);
      }}
      style={{ left: node.position_x ?? 0, top: node.position_y ?? 0, zIndex: selected ? 5 : 2 }}
      className={`absolute w-60 cursor-grab active:cursor-grabbing bg-panel/90 backdrop-blur border rounded-xl p-3 select-none transition-colors ${borderColor} ${
        selected ? "shadow-[0_18px_44px_rgba(0,0,0,.6),0_0_34px_rgba(34,224,240,.1)]" : "shadow-[0_14px_34px_rgba(0,0,0,.5)]"
      }`}
    >
      {/* in port: agents and environments-as-sources don't receive; only agents can be an edge target */}
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
        title={agent ? "Share context" : env ? "Attach this environment to an agent" : "Attach this tool to an agent"}
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
            {agent ? node.agent_slug : env ? `${node.runtime} sandbox` : (node as ToolNode).tool_slug}
          </div>
        </div>
        <button
          data-btn
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={agent ? "Delete agent" : env ? "Delete environment" : "Delete tool"}
          className="shrink-0 text-white/30 hover:text-white/70 text-sm px-0.5"
        >
          ×
        </button>
      </div>

      {agent && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 min-h-[26px]">
          {attachedTools && attachedTools.length > 0 ? (
            attachedTools.map(({ edge, tool }) => (
              <span
                key={edge.id}
                data-chip
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onChipClick?.(tool.id);
                }}
                title={`${tool.name} — click to inspect`}
                className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md text-[10px] bg-accent/10 border border-accent/30 text-accent cursor-pointer hover:bg-accent/15"
              >
                <span className="opacity-80">{TOOL_ICONS[tool.tool_slug] ?? "◆"}</span>
                <span className="max-w-[86px] truncate">{tool.name}</span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onChipRemove?.(edge);
                  }}
                  title={`Unequip ${tool.name}`}
                  className="ml-0.5 text-accent/60 hover:text-accent px-0.5"
                >
                  ×
                </span>
              </span>
            ))
          ) : (
            <span className="text-[10px] text-white/25 border border-dashed border-white/15 rounded-md px-2 py-1">
              no tools — drop one here
            </span>
          )}
        </div>
      )}

      {agent ? (
        <div className="mt-2.5 pt-2.5 border-t border-border flex items-center gap-2 text-[10px] text-muted">
          <span>
            Policy: <span className="text-text/70">{node.tool_policy}</span>
          </span>
          {node.status && (
            <span className="flex items-center gap-1">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  node.status === "running"
                    ? "bg-amber animate-pulse"
                    : node.status === "error"
                    ? "bg-red-400"
                    : node.status === "ready"
                    ? "bg-green"
                    : "bg-white/30"
                }`}
              />
              <span className="uppercase tracking-wide">{node.status}</span>
            </span>
          )}
          {typeof environmentCount === "number" && environmentCount > 0 && (
            <span className="ml-auto">
              {ENV_ICON} {environmentCount}
            </span>
          )}
        </div>
      ) : env ? (
        <div className="mt-2.5 pt-2.5 border-t border-border flex items-center gap-2 text-[10px]">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              node.status === "ready"
                ? "bg-green"
                : node.status === "error"
                ? "bg-red-400"
                : node.status === "provisioning"
                ? "bg-amber animate-pulse"
                : "bg-white/30"
            }`}
          />
          <span className="text-muted uppercase tracking-wide">{node.status}</span>
          {node.sandbox_id && (
            <span className="ml-1 truncate text-muted/80" title={node.sandbox_id}>
              · {node.sandbox_id.slice(0, 8)}
            </span>
          )}
        </div>
      ) : (
        <div className="mt-2.5 pt-2.5 border-t border-border flex items-center gap-2 text-[10px]">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              (node as ToolNode).status === "ready"
                ? "bg-green"
                : (node as ToolNode).status === "error"
                ? "bg-red-400"
                : "bg-white/30"
            }`}
          />
          <span className="text-muted uppercase tracking-wide">{(node as ToolNode).status}</span>
          {(node as ToolNode).status_detail && (
            <span className="ml-1 truncate text-muted/80" title={(node as ToolNode).status_detail!}>
              — {(node as ToolNode).status_detail}
            </span>
          )}
        </div>
      )}

      {linking && !linkHover && (
        <div className="absolute inset-0 rounded-xl pointer-events-none border border-dashed border-white/10" />
      )}
      {dropHighlight && (
        <div className="absolute inset-0 rounded-xl pointer-events-none border-2 border-green shadow-[0_0_20px_rgba(126,231,135,.3)]" />
      )}
    </div>
  );
}
