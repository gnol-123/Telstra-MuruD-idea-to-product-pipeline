"use client";

import { AgentType, ToolType, ToolPreset } from "@/lib/types";
import { AGENT_ICONS, TOOL_ICONS, ENV_ICON } from "./NodeCard";

export type PaletteTab = "agents" | "tools" | "environments";

function DragCard({
  payload,
  onClick,
  onDoubleClick,
  title,
  icon,
  label,
  sub,
}: {
  payload: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
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
      onDoubleClick={onDoubleClick}
      title={title}
      className="shrink-0 flex items-center gap-2 border border-border rounded-lg px-3 py-1.5 text-xs hover:border-accent/40 cursor-grab active:cursor-grabbing bg-white/[0.03]"
    >
      <span className="text-accent">{icon}</span>
      <div>
        <div>{label}</div>
        {sub && <div className="text-[10px] text-muted">{sub}</div>}
      </div>
    </div>
  );
}

export default function Palette({
  tab,
  onTabChange,
  agentTypes,
  toolTypes,
  toolPresets,
  onAddAgent,
  onAddTool,
  onAddPreset,
  onAddEnvironment,
}: {
  tab: PaletteTab;
  onTabChange: (tab: PaletteTab) => void;
  agentTypes: AgentType[];
  toolTypes: ToolType[];
  toolPresets: ToolPreset[];
  onAddAgent: (agentSlug: string) => void;
  onAddTool: (toolSlug: string) => void;
  onAddPreset: (presetSlug: string) => void;
  onAddEnvironment: () => void;
}) {
  const tabBtn = (t: PaletteTab, label: string) => (
    <button
      onClick={() => onTabChange(t)}
      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        tab === t ? "bg-accent/15 text-accent" : "text-muted hover:text-text hover:bg-white/[0.06]"
      }`}
    >
      {label}
    </button>
  );

  const hint =
    tab === "agents"
      ? "Drag onto the canvas to add, or click."
      : tab === "tools"
      ? "Drag a tool onto an agent card to equip it."
      : "Drag onto the canvas to provision a sandbox.";

  const title =
    tab === "agents" ? "Agent library" : tab === "tools" ? "Tool shelf" : "Environments";

  return (
    <div className="flex items-start gap-4 px-5 py-3 border-b border-border bg-white/[0.014] min-h-[74px]">
      <div className="flex flex-none flex-col gap-2 pr-4 border-r border-white/20 w-[150px]">
        <div className="flex gap-1 p-0.5 border border-white/20 rounded-lg bg-white/[0.06] w-fit">
          {tabBtn("agents", "Agents")}
          {tabBtn("tools", "Tools")}
          {tabBtn("environments", "Env")}
        </div>
        <div className="text-[9.5px] tracking-wider uppercase text-white/30">{title}</div>
        <div className="text-[10px] text-muted leading-tight">{hint}</div>
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
              <div className="text-xs text-muted">No agent types returned from the catalog yet.</div>
            )}
          </div>
        )}

        {tab === "tools" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[9px] tracking-widest uppercase text-white/25 flex-none w-16">Types</span>
              <div className="flex gap-2 overflow-x-auto">
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
                  <div className="text-xs text-muted">No tool types returned from the catalog yet.</div>
                )}
              </div>
            </div>
            {toolPresets.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[9px] tracking-widest uppercase text-white/25 flex-none w-16">Presets</span>
                <div className="flex gap-2 overflow-x-auto">
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
      </div>

      <div className="ml-auto text-[10px] text-muted shrink-0 self-center max-w-[190px] text-right leading-tight">
        Drop a tool onto an agent card to equip it · drag from a port to link agents and environments
      </div>
    </div>
  );
}
