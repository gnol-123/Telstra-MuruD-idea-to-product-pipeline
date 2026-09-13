"use client";

import { AgentType, ToolType } from "@/lib/types";

// Cosmetic-only lookup so known agent slugs get a nicer icon than the raw
// slug — falls back gracefully for any slug not in this list, so it doesn't
// break if the backend catalog changes.
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

export type PaletteTab = "agents" | "tools";

export default function Palette({
  tab,
  onTabChange,
  agentTypes,
  toolTypes,
  onAddAgent,
  onAddTool,
}: {
  tab: PaletteTab;
  onTabChange: (tab: PaletteTab) => void;
  agentTypes: AgentType[];
  toolTypes: ToolType[];
  onAddAgent: (agentSlug: string) => void;
  onAddTool: (toolSlug: string) => void;
}) {
  const tabBtn = (t: PaletteTab, label: string) => (
    <button
      onClick={() => onTabChange(t)}
      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        tab === t ? "bg-accent/15 text-accent" : "text-muted hover:text-text"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-start gap-4 px-5 py-3 border-b border-border bg-white/[0.014] min-h-[74px]">
      <div className="flex flex-none flex-col gap-2 pr-4 border-r border-border w-[150px]">
        <div className="flex gap-1 p-0.5 border border-border rounded-lg w-fit">
          {tabBtn("agents", "Agents")}
          {tabBtn("tools", "Tools")}
        </div>
        <div className="text-[10px] text-muted leading-tight">
          {tab === "agents"
            ? "Drag onto the canvas to add, or click."
            : "Drag a tool onto the canvas to configure it."}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-x-auto pb-0.5">
        {tab === "agents" ? (
          <div className="flex gap-2">
            {agentTypes.map((t) => (
              <div
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", `agent:${t.slug}`);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => onAddAgent(t.slug)}
                className="shrink-0 flex items-center gap-2 border border-border rounded-lg px-3 py-1.5 text-xs hover:border-accent/40 cursor-grab active:cursor-grabbing bg-white/[0.03]"
              >
                <span className="text-accent">{AGENT_ICONS[t.slug] ?? "◆"}</span>
                {t.name}
              </div>
            ))}
            {agentTypes.length === 0 && (
              <div className="text-xs text-muted">No agent types returned from the catalog yet.</div>
            )}
          </div>
        ) : (
          <div className="flex gap-2">
            {toolTypes.map((t) => (
              <div
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", `tool:${t.slug}`);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => onAddTool(t.slug)}
                title={t.description}
                className="shrink-0 flex items-center gap-2 border border-border rounded-lg px-3 py-1.5 text-xs hover:border-accent/40 cursor-grab active:cursor-grabbing bg-white/[0.03]"
              >
                <span className="text-accent">{TOOL_ICONS[t.slug] ?? "◆"}</span>
                <div>
                  <div>{t.name}</div>
                  <div className="text-[10px] text-muted">
                    {t.auth_kind === "oauth2" ? "Connect account" : "API key / config"}
                  </div>
                </div>
              </div>
            ))}
            {toolTypes.length === 0 && (
              <div className="text-xs text-muted">No tool types returned from the catalog yet.</div>
            )}
          </div>
        )}
      </div>

      <div className="ml-auto text-[10px] text-muted shrink-0 self-center">
        Drag from a node&apos;s ◗ port to another node to link them
      </div>
    </div>
  );
}
