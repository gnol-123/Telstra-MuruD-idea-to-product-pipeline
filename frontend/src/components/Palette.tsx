"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AgentType, ToolType, ToolPreset, Edge, ProjectNode } from "@/lib/types";
import { AGENT_ICONS, TOOL_ICONS } from "./NodeCard";

// Environments no longer get a tab: every project has its scratch sandbox
// built in, and agents attach to it automatically.
export type PaletteTab = "agents" | "tools" | "context";

export const PALETTE_TABS: { id: PaletteTab; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "tools", label: "Tools" },
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

// ---------------------------------------------------------------------------
// Tool shelf

// The catalog has no category column, so group by the underlying tool type.
// Unknown types fall into "Other" rather than disappearing.
const CATEGORIES = ["Search", "Knowledge", "Design", "Build", "Comms", "Skills", "Other"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_OF: Record<string, Category> = {
  brave_search: "Search",
  web_fetch: "Search",
  context7: "Knowledge",
  obsidian: "Knowledge",
  canvas: "Design",
  figma: "Design",
  github: "Build",
  mcp_server: "Build",
  gmail: "Comms",
  slack: "Comms",
  skill: "Skills",
};

interface ShelfItem {
  key: string;
  payload: string;
  name: string;
  description: string;
  toolSlug: string;
  category: Category;
  preset: boolean;
  onAdd: () => void;
}

function ToolChip({ item }: { item: ShelfItem }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.payload);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={item.onAdd}
      title={`${item.description || item.name}\n${
        item.preset ? "Ready to equip — drop it on an agent card." : "Needs setup — drop it on an agent card to configure."
      }`}
      className="group shrink-0 flex items-center gap-2 h-[34px] pl-[7px] pr-3 rounded-[9px] cursor-grab active:cursor-grabbing whitespace-nowrap bg-white/[0.03] border border-white/[0.12] hover:border-accent/45 hover:bg-white/[0.05] transition-colors"
    >
      <span className="w-[21px] h-[21px] grid place-items-center rounded-[6px] bg-accent/[0.12] border border-accent/25 text-accent text-[10.5px] leading-none">
        {TOOL_ICONS[item.toolSlug] ?? "◆"}
      </span>
      <span className="text-[12px] text-white/85 group-hover:text-text">{item.name}</span>
    </div>
  );
}

function ToolShelf({
  toolTypes,
  toolPresets,
  active,
  onAddTool,
  onAddPreset,
}: {
  toolTypes: ToolType[];
  toolPresets: ToolPreset[];
  active: boolean;
  onAddTool: (toolSlug: string) => void;
  onAddPreset: (presetSlug: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "All">("All");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // "/" jumps to search while the Tools tab is showing, unless the user is
  // already typing somewhere.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Most API tools ship as both a tool type and a ready-made preset of the
  // same name (e.g. Brave Search, Web Fetch, Context7). Show one chip each:
  // the preset wins, since it equips with no setup. A type still appears
  // when no preset covers it.
  const items: ShelfItem[] = useMemo(() => {
    const presetNames = new Set(toolPresets.map((p) => p.name.trim().toLowerCase()));
    const presetSlugs = new Set(toolPresets.map((p) => p.slug));
    const types = toolTypes.filter((t) => !presetSlugs.has(t.slug) && !presetNames.has(t.name.trim().toLowerCase()));
    return [
      ...toolPresets.map((p) => ({
        key: `preset:${p.slug}`,
        payload: `preset:${p.slug}`,
        name: p.name,
        description: p.description,
        toolSlug: p.tool_slug,
        category: CATEGORY_OF[p.tool_slug] ?? "Other",
        preset: true,
        onAdd: () => onAddPreset(p.slug),
      })),
      ...types.map((t) => ({
        key: `tool:${t.slug}`,
        payload: `tool:${t.slug}`,
        name: t.name,
        description: t.description,
        toolSlug: t.slug,
        category: CATEGORY_OF[t.slug] ?? "Other",
        preset: false,
        onAdd: () => onAddTool(t.slug),
      })),
    ];
  }, [toolTypes, toolPresets, onAddTool, onAddPreset]);

  const q = query.trim().toLowerCase();
  const matchesQuery = (i: ShelfItem) =>
    !q ||
    i.name.toLowerCase().includes(q) ||
    i.description.toLowerCase().includes(q) ||
    i.toolSlug.replace(/_/g, " ").includes(q) ||
    i.category.toLowerCase().includes(q);

  // Counts follow the search, so the pills say how many hits each group has.
  const searched = items.filter(matchesQuery);
  const counts = new Map<Category, number>();
  for (const i of searched) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
  const presentCategories = CATEGORIES.filter((c) => items.some((i) => i.category === c));

  const shown = searched.filter((i) => category === "All" || i.category === category);
  const groups = CATEGORIES.map((c) => ({ category: c, items: shown.filter((i) => i.category === c) })).filter(
    (g) => g.items.length > 0
  );

  return (
    <div className="flex flex-col gap-2.5 min-w-0">
      <div className="flex items-center gap-3 min-w-0">
        <label className="flex-none flex items-center gap-2 w-[260px] h-[34px] px-3 rounded-[9px] border border-white/[0.13] bg-white/[0.03] focus-within:border-accent/50 transition-colors">
          <span className="text-white/35 text-[13px] leading-none" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (query) setQuery("");
                else inputRef.current?.blur();
              }
            }}
            placeholder="Search tools"
            aria-label="Search tools"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px] text-text placeholder:text-white/35"
          />
          {query ? (
            <button
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="text-white/40 hover:text-white/80 text-[13px] leading-none"
              aria-label="Clear search"
            >
              ×
            </button>
          ) : (
            <kbd className="grid place-items-center min-w-[18px] h-[18px] px-1 rounded-[4px] border border-white/20 text-[10px] font-mono text-white/45">
              /
            </kbd>
          )}
        </label>

        <span className="flex-none w-px h-6 bg-white/[0.1]" />

        <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto" role="tablist" aria-label="Tool categories">
          {(["All", ...presentCategories] as const).map((c) => {
            const on = category === c;
            const n = c === "All" ? searched.length : counts.get(c) ?? 0;
            return (
              <button
                key={c}
                role="tab"
                aria-selected={on}
                onClick={() => setCategory(c)}
                className={`flex-none flex items-center gap-1.5 h-[30px] px-3 rounded-full border text-[12px] transition-colors ${
                  on
                    ? "bg-accent/[0.14] border-accent/55 text-accent font-semibold"
                    : "border-white/[0.13] text-white/65 hover:text-text hover:border-white/30"
                } ${!on && n === 0 ? "opacity-45" : ""}`}
              >
                {c}
                <span className={`text-[10.5px] font-normal ${on ? "text-accent/75" : "text-white/35"}`}>{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-4 min-w-0 overflow-x-auto pb-0.5">
        {groups.map((g, gi) => (
          <div key={g.category} className="flex-none flex items-center gap-2.5">
            {gi > 0 && <span className="w-px h-6 bg-white/[0.1] mr-1.5" />}
            <span className="text-[9.5px] tracking-[0.12em] uppercase text-white/[0.32] mr-0.5">{g.category}</span>
            {g.items.map((item) => (
              <ToolChip key={item.key} item={item} />
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <div className="h-[34px] flex items-center gap-2 text-[11.5px] text-white/40">
            {items.length === 0 ? (
              "No tools returned from the catalog yet."
            ) : (
              <>
                No tools match {q ? <span className="text-white/70">“{query.trim()}”</span> : "this filter"}
                {category !== "All" && " in " + category}.
                <button
                  onClick={() => {
                    setQuery("");
                    setCategory("All");
                  }}
                  className="text-accent hover:underline underline-offset-[3px]"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const COPY: Record<PaletteTab, [string, string]> = {
  agents: ["Agent library", "Drag onto the canvas to add — or click."],
  tools: ["Tool shelf", "Drag a tool onto an agent card to equip it."],
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
  onRefreshEdge: (edge: Edge) => void;
  onDeleteEdge: (edge: Edge) => void;
}) {
  const [title, hint] = COPY[tab];
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? "Unknown";
  const links = edges.filter((e) => e.kind !== "tool");

  return (
    <div className="flex-none flex items-start gap-4 px-5 py-3 border-b border-white/[0.09] bg-white/[0.014] min-h-[74px]">
      <div className="flex-none flex flex-col gap-0.5 pr-4 border-r border-white/[0.08] w-[172px] self-stretch">
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

        {/* Kept mounted so the search and filter survive a tab switch. */}
        <div className={tab === "tools" ? "" : "hidden"}>
          <ToolShelf
            toolTypes={toolTypes}
            toolPresets={toolPresets}
            active={tab === "tools"}
            onAddTool={onAddTool}
            onAddPreset={onAddPreset}
          />
        </div>

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
