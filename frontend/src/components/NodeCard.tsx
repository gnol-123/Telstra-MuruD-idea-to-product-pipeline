"use client";

import { useState } from "react";
import { PORT_Y } from "./EdgeLayer";
import { Edge, ProjectNode, ToolNode, EnvironmentNode, isAgentNode, isEnvironmentNode } from "@/lib/types";

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

// Chips shown on an agent card before collapsing into "N+".
const MAX_CHIPS = 2;

// One-line role descriptions shown under an agent's name, matching the UX
// mockup. The catalog (/agent-types) only returns a name + slug, so these
// live client-side; unknown slugs just fall back to the slug itself.
export const AGENT_ROLES: Record<string, string> = {
  market_research: "Gathers market + competitor evidence",
  project_scoping: "Shapes the concept, brief and scope",
  coding: "Scaffolds, tests and ships code",
  ux_ui: "Turns briefs into UI and mockups",
  orchestrator: "Plans the work and provisions other agents",
};

export function agentRole(slug: string | undefined) {
  if (!slug) return "Agent";
  return AGENT_ROLES[slug] ?? slug.replace(/_/g, " ");
}

export interface AttachedTool {
  edge: Edge;
  tool: ToolNode;
}
export interface AttachedEnvironment {
  edge: Edge;
  env: EnvironmentNode;
}

export default function NodeCard({
  node,
  selected,
  linking,
  linkHover,
  attachedTools,
  attachedEnvironments,
  inboundCount,
  staleCount,
  busy,
  deleting,
  zoom,
  onSelect,
  onDragMove,
  onDragEnd,
  onDelete,
  onPortDown,
  onCardPointerUp,
  onHoverChange,
  onDropOnCard,
  onChipClick,
  onChipRemove,
  onClearStale,
  onOpenChat,
  onOpenWorkspace,
}: {
  node: ProjectNode;
  selected: boolean;
  linking: boolean;
  linkHover: boolean;
  // Agent nodes only: tool nodes attached via an inbound `tool` edge,
  // rendered as chips on the card itself rather than as separate boxes.
  attachedTools?: AttachedTool[];
  attachedEnvironments?: AttachedEnvironment[];
  inboundCount?: number;
  // Agent nodes only: inbound context links whose summary is out of date.
  staleCount?: number;
  // Agent nodes only: a chat turn is in flight for this agent right now.
  busy?: boolean;
  // Delete is in flight: card dims, x becomes a spinner.
  deleting?: boolean;
  // Canvas scale; pointer deltas are divided by it.
  zoom: number;
  onSelect: () => void;
  // Fires per pointermove. State only; PATCH happens on drag end.
  onDragMove: (x: number, y: number) => void;
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
  onClearStale?: () => void;
  // envId: open with that environment's workspace panel expanded.
  onOpenChat?: (envId?: string) => void;
  // Opens the code preview on an environment, optionally at a folder.
  onOpenWorkspace?: (envId: string, path?: string | null) => void;
}) {
  const agent = isAgentNode(node);
  const env = isEnvironmentNode(node);
  // Native HTML5 drag-over state (a tool/preset card being dragged from the
  // palette), tracked separately from `linkHover` — that one is for the
  // pointer-based port-to-port linking gesture, a different drag system.
  const [nativeDragOver, setNativeDragOver] = useState(false);
  const [chipsOpen, setChipsOpen] = useState(false);
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

    function onMove(ev: PointerEvent) {
      latestX = originX + (ev.clientX - startX) / zoom;
      latestY = originY + (ev.clientY - startY) / zoom;
      // State, not card.style; EdgeLayer reads the same position.
      onDragMove(latestX, latestY);
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
    : "border-white/[0.13]";

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
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-port],[data-btn],[data-chip]")) return;
        if (agent) onOpenChat?.();
        else if (env) onOpenWorkspace?.(node.id);
      }}
      style={{ left: node.position_x ?? 0, top: node.position_y ?? 0, zIndex: selected ? 5 : 2 }}
      className={`absolute w-60 cursor-grab active:cursor-grabbing touch-none backdrop-blur-md border rounded-[13px] px-3.5 pt-[13px] pb-3 select-none transition-[border-color,background-color,opacity] ${borderColor} ${
        selected
          ? "bg-accent/[0.045] shadow-[0_18px_44px_rgba(0,0,0,.6),0_0_34px_rgba(34,224,240,.1)]"
          : "bg-white/[0.022] shadow-[0_14px_34px_rgba(0,0,0,.5)]"
      } ${deleting ? "opacity-45 pointer-events-none" : ""}`}
    >
      {/* in port: agents and environments-as-sources don't receive; only agents can be an edge target */}
      {agent && (
        <div
          data-port="in"
          onPointerDown={(e) => {
            e.stopPropagation();
            // Touch implicitly captures to the port; release so pointerup hits the target card.
            e.currentTarget.releasePointerCapture(e.pointerId);
            onPortDown("in");
          }}
          title="Receive context"
          style={{ top: PORT_Y - 10 }}
          className={`absolute -left-[10px] w-5 h-5 rounded-full bg-panel2 cursor-crosshair touch-none border-2 ${
            (inboundCount ?? 0) > 0 ? "border-accent" : "border-white/30"
          }`}
        />
      )}
      {/* out port: any node can be an edge source */}
      <div
        data-port="out"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.currentTarget.releasePointerCapture(e.pointerId);
          onPortDown("out");
        }}
        title={agent ? "Share context" : env ? "Attach this environment to an agent" : "Attach this tool to an agent"}
        style={{ top: PORT_Y - 10 }}
        className="absolute -right-[10px] w-5 h-5 rounded-full bg-accent border-2 border-panel2 cursor-crosshair touch-none shadow-[0_0_10px_rgba(34,224,240,0.5)]"
      />

      <div className="flex items-start gap-2.5">
        <div
          className={`shrink-0 w-[30px] h-[30px] rounded-lg border grid place-items-center text-[13px] ${
            selected ? "border-accent text-accent" : "border-white/[0.18] text-white/60"
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold tracking-[-0.01em] truncate">{node.name}</div>
          <div className="mt-[3px] text-[10.5px] text-white/40 leading-[1.35] line-clamp-2">
            {agent
              ? agentRole(node.agent_slug)
              : env
              ? `${node.runtime} sandbox · ${node.role === "scratch" ? "shared scratch space" : "shell + filesystem"}`
              : ((node as ToolNode).tool_slug ?? "tool").replace(/_/g, " ")}
          </div>
        </div>
        <button
          data-btn
          disabled={deleting}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={
            deleting ? "Deleting..." : agent ? "Delete agent" : env ? "Delete environment" : "Delete tool"
          }
          className="shrink-0 text-white/[0.28] hover:text-white/70 text-[13px] px-0.5 leading-none disabled:hover:text-white/[0.28]"
        >
          {deleting ? (
            <span className="block w-[11px] h-[11px] rounded-full border border-white/25 border-t-white/70 animate-spin" />
          ) : (
            "×"
          )}
        </button>
      </div>

            {agent && (
        <div className="mt-[11px] flex flex-wrap gap-[5px] min-h-[24px]">
          {(attachedTools?.length ?? 0) === 0 && (attachedEnvironments?.length ?? 0) === 0 ? (
            <span className="text-[10px] text-white/25 border border-dashed border-white/[0.13] rounded-[5px] px-2 py-[3px]">
              no tools or environments — drop one here
            </span>
          ) : (() => {
            const chips = [
              ...(attachedTools ?? []).map(({ edge, tool }) => (
                <span
                  key={edge.id}
                  data-chip
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChipClick?.(tool.id);
                  }}
                  title={`${tool.name} — click to inspect`}
                  className="inline-flex items-center gap-1 pl-[7px] pr-1 py-[3px] rounded-[5px] text-[10px] bg-accent/10 border border-accent/30 text-accent cursor-pointer hover:bg-accent/15"
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
              )),
              ...(attachedEnvironments ?? []).map(({ edge, env: envNode }) => (
                <span
                  key={edge.id}
                  data-chip
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChipClick?.(envNode.id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onOpenChat?.(envNode.id);
                  }}
                  title={`${envNode.name} — click to inspect, double-click to open ${node.name}'s files`}
                  className="inline-flex items-center gap-1 pl-[7px] pr-1 py-[3px] rounded-[5px] text-[10px] bg-accent/10 border border-accent/30 text-accent cursor-pointer hover:bg-accent/15"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      envNode.status === "ready"
                        ? "bg-green"
                        : envNode.status === "error"
                        ? "bg-red-400"
                        : envNode.status === "provisioning"
                        ? "bg-amber animate-pulse"
                        : "bg-white/30"
                    }`}
                  />
                  <span className="opacity-80">{ENV_ICON}</span>
                  <span className="max-w-[86px] truncate">{envNode.name}</span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onChipRemove?.(edge);
                    }}
                    title={`Detach ${envNode.name}`}
                    className="ml-0.5 text-accent/60 hover:text-accent px-0.5"
                  >
                    ×
                  </span>
                </span>
              )),
            ];
            const hidden = chips.length - MAX_CHIPS;
            if (hidden <= 0) return chips;
            return (
              <>
                {chipsOpen ? chips : chips.slice(0, MAX_CHIPS)}
                <span
                  data-chip
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setChipsOpen((o) => !o);
                  }}
                  title={chipsOpen ? "Show less" : `${hidden} more`}
                  className="inline-flex items-center px-[7px] py-[3px] rounded-[5px] text-[10px] border border-white/[0.16] text-white/50 cursor-pointer hover:text-white/80"
                >
                  {chipsOpen ? "less" : `${hidden}+`}
                </span>
              </>
            );
          })()}
        </div>
      )}

      {agent ? (
        <div className="mt-[11px] pt-2.5 border-t border-white/[0.07] flex items-center gap-2">
          {(() => {
            // A turn in flight on this client wins over the polled backend
            // value, which today only ever reads "ready" for agents.
            const status = busy ? "running" : node.status ?? "ready";
            return (
              <>
                <span
                  className={`w-[5px] h-[5px] rounded-full shrink-0 ${
                    status === "running"
                      ? "bg-green anim-softpulse"
                      : status === "error"
                      ? "bg-red-400"
                      : "bg-white/30"
                  }`}
                />
                <span className="shrink-0 text-[10px] text-white/[0.42] tracking-[0.04em] uppercase whitespace-nowrap">
                  {status}
                </span>
              </>
            );
          })()}
          {(inboundCount ?? 0) > 0 && (
            <span className="shrink-0 whitespace-nowrap text-[10px] text-white/[0.32]">· {inboundCount} in</span>
          )}
          {(staleCount ?? 0) > 0 && (
            <button
              data-btn
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClearStale?.();
              }}
              title="Stale context — click to clear and pull the latest upstream output"
              className="shrink-0 w-5 h-5 grid place-items-center rounded-full text-[11px] leading-none text-amber border border-amber/45 bg-amber/10 hover:bg-amber/20"
            >
              ⟳
            </button>
          )}
          <button
            data-btn
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenChat?.();
            }}
            className={`ml-auto shrink-0 whitespace-nowrap bg-transparent border rounded-md px-2.5 py-[5px] text-[10.5px] font-medium transition-colors ${
              selected
                ? "border-accent/45 text-accent"
                : "border-white/[0.16] text-white/60 hover:text-text hover:border-white/30"
            }`}
          >
            Open chat
          </button>
        </div>
      ) : env ? (
        <div className="mt-[11px] pt-2.5 border-t border-white/[0.07] flex items-center gap-2 text-[10px]">
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
          <span className="text-muted uppercase tracking-wide" title={node.sandbox_id ?? undefined}>
            {node.status}
          </span>
          <button
            data-btn
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenWorkspace?.(node.id);
            }}
            className={`ml-auto shrink-0 whitespace-nowrap bg-transparent border rounded-md px-2.5 py-[5px] text-[10.5px] font-medium transition-colors ${
              selected ? "border-green/45 text-green" : "border-white/[0.16] text-white/60 hover:text-text hover:border-white/30"
            }`}
          >
            Open workspace
          </button>
        </div>
      ) : (
        <div className="mt-[11px] pt-2.5 border-t border-white/[0.07] flex items-center gap-2 text-[10px]">
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
