"use client";

import { Edge, ProjectNode } from "@/lib/types";

const CY = "#22e0f0";
const AMBER = "#ffb74d";
const GREEN = "#7ee787";

export const CARD_W = 240;
export const PORT_Y = 32;
export const LAYER_W = 2400;
export const LAYER_H = 1600;

export interface LinkDraft {
  fromId: string;
  side: "in" | "out";
  cursor: { x: number; y: number };
}

export function portOf(n: ProjectNode, side: "in" | "out") {
  const x = (n.position_x ?? 0) + (side === "out" ? CARD_W : 0);
  const y = (n.position_y ?? 0) + PORT_Y;
  return { x, y };
}

function curve(p1: { x: number; y: number }, p2: { x: number; y: number }) {
  const dx = Math.max(48, Math.abs(p2.x - p1.x) * 0.45);
  return `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`;
}

export default function EdgeLayer({
  nodes,
  edges,
  selectedId,
  link,
  refreshingId,
  onRefresh,
  onDelete,
  onSelectNode,
}: {
  nodes: ProjectNode[];
  edges: Edge[];
  selectedId: string | null;
  link: LinkDraft | null;
  refreshingId: string | null;
  onRefresh: (edge: Edge) => void;
  onDelete: (edge: Edge) => void;
  // Clicking a healthy link's pill jumps the inspector to its target.
  onSelectNode?: (id: string) => void;
}) {
  const nodeById = (id: string) => nodes.find((n) => n.id === id);

  // Tool attachment is now shown as a chip embedded directly on the agent
  // card (see NodeCard), matching the design — so a `tool` edge draws no
  // line or pill here at all; only `context` and `environment` do.
  const visibleEdges = edges.filter((e) => e.kind !== "tool");

  return (
    <>
      <svg
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: LAYER_W,
          height: LAYER_H,
          overflow: "visible",
          zIndex: 1,
          pointerEvents: "none",
        }}
      >
        {visibleEdges.map((e) => {
          const a = nodeById(e.source_node_id);
          const b = nodeById(e.target_node_id);
          if (!a || !b) return null;
          const p1 = portOf(a, "out");
          const p2 = portOf(b, "in");
          const d = curve(p1, p2);
          const hot = selectedId === e.source_node_id || selectedId === e.target_node_id;
          const stale = e.kind === "context" && e.is_stale;
          const isEnv = e.kind === "environment";
          const baseCol = isEnv ? GREEN : CY;
          const col = stale ? "rgba(255,183,77,.55)" : hot ? baseCol : isEnv ? "rgba(126,231,135,.32)" : "rgba(34,224,240,.32)";
          return (
            <g key={e.id}>
              <path d={d} fill="none" stroke={col} strokeWidth={hot ? 2 : 1.5} />
              <path
                d={d}
                fill="none"
                stroke={stale ? AMBER : hot ? "rgba(255,255,255,.85)" : isEnv ? "rgba(126,231,135,.5)" : "rgba(34,224,240,.5)"}
                strokeWidth={1.5}
                strokeDasharray="3 9"
                style={{ animation: stale ? "none" : "dash 1.1s linear infinite" }}
              />
              <circle cx={p2.x} cy={p2.y} r={3.5} fill={stale ? AMBER : hot ? baseCol : isEnv ? "rgba(126,231,135,.5)" : "rgba(34,224,240,.5)"} />
            </g>
          );
        })}
        {link &&
          (() => {
            const a = nodeById(link.fromId);
            if (!a) return null;
            const p1 = portOf(a, link.side);
            const c = link.cursor;
            return (
              <>
                <path
                  d={`M${p1.x},${p1.y} C${p1.x + 70},${p1.y} ${c.x - 70},${c.y} ${c.x},${c.y}`}
                  fill="none"
                  stroke={CY}
                  strokeWidth={2}
                  strokeDasharray="5 6"
                  opacity={0.9}
                />
                <circle cx={c.x} cy={c.y} r={4} fill={CY} />
              </>
            );
          })()}
      </svg>

      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: LAYER_W,
          height: LAYER_H,
          zIndex: 3,
          pointerEvents: "none",
        }}
      >
        {visibleEdges.map((e) => {
          const a = nodeById(e.source_node_id);
          const b = nodeById(e.target_node_id);
          if (!a || !b) return null;
          const p1 = portOf(a, "out");
          const p2 = portOf(b, "in");
          const stale = e.kind === "context" && e.is_stale;
          const isEnv = e.kind === "environment";
          const hot = selectedId === e.source_node_id || selectedId === e.target_node_id;
          const busy = refreshingId === e.id;
          const label = isEnv ? "ENVIRONMENT" : stale ? "CLEAR STALE" : "CONTEXT";
          const accentCol = isEnv ? GREEN : CY;
          return (
            <div
              key={e.id}
              style={{
                position: "absolute",
                left: (p1.x + p2.x) / 2,
                top: (p1.y + p2.y) / 2,
                transform: "translate(-50%,-50%)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                pointerEvents: "auto",
              }}
            >
              <button
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (stale) onRefresh(e);
                  else onSelectNode?.(e.target_node_id);
                }}
                title={
                  isEnv
                    ? `${b.name} can execute in ${a.name}`
                    : stale
                    ? `Stale — click to refresh ${a.name}'s summary for ${b.name}`
                    : `Context link — ${a.name} → ${b.name}`
                }
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[9.5px] tracking-wide"
                style={{
                  fontWeight: stale ? 600 : 400,
                  background: stale ? AMBER : "#05080a",
                  color: stale ? "#2b1a00" : hot ? accentCol : "rgba(255,255,255,.5)",
                  border: `1px solid ${stale ? AMBER : hot ? `${accentCol}80` : "rgba(255,255,255,.16)"}`,
                  boxShadow: stale ? "0 0 16px rgba(255,183,77,.35)" : "none",
                  cursor: "pointer",
                }}
              >
                <span>{isEnv ? "▣" : stale ? "⟳" : "◗"}</span>
                {busy ? "CLEARING…" : label}
              </button>
              <button
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDelete(e);
                }}
                title="Cut this link"
                className="w-[19px] h-[19px] rounded-full grid place-items-center leading-none bg-[#05080a] border border-white/15 text-white/40 hover:text-white/80 hover:border-white/40 text-[11px]"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
