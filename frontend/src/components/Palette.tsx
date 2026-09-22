"use client";

import { AgentType, ToolType, ToolPreset, Edge, ProjectNode } from "@/lib/types";
import { AGENT_ICONS, TOOL_ICONS, ENV_ICON } from "./NodeCard";

export type PaletteTab = "agents" | "tools" | "environments" | "context";

export const PALETTE_TABS: { id: PaletteTab; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "tools", label: "Tools" },
  { id: "environments", label: "Environments" },
  { id: "context", label: "Context" },
];

// The tab switcher lives in the top bar (see MeshCanvas), matching the UX
// mockup — the palette strip underneath just shows whatever tab is active.
export function PaletteTabs({ tab, onTabChange }: { tab: PaletteTab; onTabChange: (t: PaletteTab) => void }) {
  return (
    <nav className="flex gap-1 p-[3px] border border-white/10 rounded-[9px]">
      {PALETTE_TABS.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className={`rounded-[7px] px-[13px] py-[7px] text-xs transition-colors ${
              active ? "bg-accent/[0.14] text-accent font-semibold" : "text-white/50 hover:text-text"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

function DragCard({
  payload,
  onClick,
  title,
  icon,
  label,
  sub,
}: {
  payload: string;
  onClick?: () => void;
  title?: string;
  icon: string;
  label: string;
  sub?: string;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", payload);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onClick}
      title={title ?? "Drag onto the canvas, or click to add"}
      className="shrink-0 flex items-center gap-[9px] rounded-[9px] px-[13px] py-[9px] cursor-grab active:cursor-grabbing whitespace-nowrap bg-white/[0.03] border border-white/[0.12] hover:border-accent/40 hover:bg-white/[0.05] transition-colors"
    >
      <span className="text-accent text-xs">{icon}</span>
      <span>
        <div className="text-xs font-medium">{label}</div>
        {sub && <div className="text-[10px] text-white/[0.35] mt-px">{sub}</div>}
      </span>
    </div>
  );
}

const COPY: Record<PaletteTab, [string, string]> = {
  agents: ["Agent library", "Drag onto the canvas to add — or click."],
  tools: ["Tool shelf", "Drag a tool onto an agent card to equip it."],
  environments: ["Environments", "Drag onto the canvas to provision a sandbox."],
  context: ["Context links", "Each link streams the upstream agent’s summary downstream."],
};

export default function Palette({
  tab,
  agentTypes,
  toolTypes,
  toolPresets,
  nodes,
  edges,
  refreshingEdgeId,
  onAddAgent,
  onAddTool,
  onAddPreset,
  onAddEnvironment,
  onRefreshEdge,
  onDeleteEdge,
}: {
  tab: PaletteTab;
  agentTypes: AgentType[];
  toolTypes: ToolType[];
  toolPresets: ToolPreset[];
  nodes: ProjectNode[];
  edges: Edge[];
  refreshingEdgeId: string | null;
  onAddAgent: (agentSlug: string) => void;
  onAddTool: (toolSlug: string) => void;
  onAddPreset: (presetSlug: string) => void;
  onAddEnvironment: () => void;
  onRefreshEdge: (edge: Edge) => void;
  onDeleteEdge: (edge: Edge) => void;
}) {
  const [title, hint] = COPY[tab];
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? "Unknown";
  const links = edges.filter((e) => e.kind !== "tool");

  return (
    <div className="flex-none flex items-start gap-4 px-5 py-3 border-b border-white/[0.09] bg-white/[0.014] min-h-[74px]">
      <div className="flex-none flex flex-col gap-0.5 pr-4 border-r border-white/[0.08] w-[172px]">
        <div className="text-[11.5px] font-semibold">{title}</div>
        <div className="text-[10.5px] text-white/[0.35] leading-[1.4]">{hint}</div>
      </div>

      <div className="flex-1 min-w-0 overflow-x-auto pb-0.5">
        {tab === "agents" && (
          <div className="flex gap-2">
            {agentTypes.map((t) => (
              <DragCard
                key={t.id}
                payload={`agent:${t.slug}`}
                onClick={() => onAddAgent(t.slug)}
                icon={AGENT_ICONS[t.slug] ?? "◆"}
                label={t.name}
                sub={
                  t.default_presets && t.default_presets.length
                    ? `${t.default_presets.length} default tool${t.default_presets.length === 1 ? "" : "s"}`
                    : "no default tools"
                }
              />
            ))}
            {agentTypes.length === 0 && (
              <div className="text-[11.5px] text-white/[0.35] self-center">No agent types returned from the catalog yet.</div>
            )}
          </div>
        )}

        {tab === "tools" && (
          <div className="flex gap-5 items-stretch">
            <div className="flex flex-col gap-1.5 flex-none">
              <div className="text-[9.5px] tracking-[0.11em] uppercase text-white/[0.28]">Types</div>
              <div className="flex gap-[7px]">
                {toolTypes.map((t) => (
                  <DragCard
                    key={t.id}
                    payload={`tool:${t.slug}`}
                    onClick={() => onAddTool(t.slug)}
                    title={t.description}
                    icon={TOOL_ICONS[t.slug] ?? "◆"}
                    label={t.name}
                    sub={t.auth_kind === "oauth2" ? "Connect account" : "API key / config"}
                  />
                ))}
                {toolTypes.length === 0 && (
                  <div className="text-[11.5px] text-white/[0.35]">No tool types returned from the catalog yet.</div>
                )}
              </div>
            </div>
            {toolPresets.length > 0 && (
              <div className="flex flex-col gap-1.5 flex-none">
                <div className="text-[9.5px] tracking-[0.11em] uppercase text-white/[0.28]">Presets</div>
                <div className="flex gap-[7px]">
                  {toolPresets.map((p) => (
                    <DragCard
                      key={p.id}
                      payload={`preset:${p.slug}`}
                      onClick={() => onAddPreset(p.slug)}
                      title={p.description}
                      icon={TOOL_ICONS[p.tool_slug] ?? "❖"}
                      label={p.name}
                      sub="ready to equip"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "environments" && (
          <div className="flex gap-2">
            <DragCard
              payload="environment:new"
              onClick={onAddEnvironment}
              icon={ENV_ICON}
              label="Sandbox"
              sub="Shell + filesystem, E2B-backed"
            />
          </div>
        )}

        {tab === "context" && (
          <div className="flex flex-col gap-1.5">
            {links.length === 0 ? (
              <div className="text-[11.5px] text-white/[0.35]">
                No context links yet — drag between agent ports on the canvas.
              </div>
            ) : (
              links.map((e) => {
                const isEnv = e.kind === "environment";
                const busy = refreshingEdgeId === e.id;
                return (
                  <div key={e.id} className="flex items-center gap-2.5 text-[11.5px] text-white/[0.62] whitespace-nowrap">
                    <span className="text-text">{nameOf(e.source_node_id)}</span>
                    <span className={`tracking-[0.1em] ${isEnv ? "text-green" : e.is_stale ? "text-amber" : "text-accent"}`}>
                      ——▸
                    </span>
                    <span className="text-text">{nameOf(e.target_node_id)}</span>
                    <span className="text-[10px] text-white/30">
                      {isEnv
                        ? "· sandbox access"
                        : e.summary_updated_at === null
                        ? "· no summary yet"
                        : e.is_stale
                        ? `· stale${e.messages_behind ? ` (${e.messages_behind} behind)` : ""}`
                        : "· synced summary"}
                    </span>
                    {!isEnv && (e.is_stale || e.summary_updated_at === null) && (
                      <button
                        onClick={() => onRefreshEdge(e)}
                        disabled={busy}
                        className="text-[10.5px] text-amber underline underline-offset-[3px] disabled:opacity-50"
                      >
                        {busy ? "refreshing…" : "refresh"}
                      </button>
                    )}
                    <button
                      onClick={() => onDeleteEdge(e)}
                      className="text-[10.5px] text-white/[0.35] hover:text-white/70 underline underline-offset-[3px]"
                    >
                      cut
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
