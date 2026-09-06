"use client";

import { AgentType } from "@/lib/types";

// Cosmetic-only lookup so known agent slugs get a nicer icon/label than the
// raw slug — falls back gracefully for any slug not in this list, so it
// doesn't break if the backend catalog changes (see mismatch note in the
// chat: current API only seeds market_research/project_scoping/coding).
const ICONS: Record<string, string> = {
  market_research: "◈",
  project_scoping: "◇",
  coding: "⌗",
};

export default function Palette({
  agentTypes,
  onAdd,
}: {
  agentTypes: AgentType[];
  onAdd: (agentSlug: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-5 py-3 border-b border-border overflow-x-auto">
      <div className="text-xs text-muted shrink-0 mr-2">Add to canvas:</div>
      {agentTypes.map((t) => (
        <button
          key={t.id}
          onClick={() => onAdd(t.slug)}
          className="shrink-0 flex items-center gap-2 border border-border rounded-lg px-3 py-1.5 text-xs hover:border-accent/40"
        >
          <span className="text-accent">{ICONS[t.slug] ?? "◆"}</span>
          {t.name}
        </button>
      ))}
      {agentTypes.length === 0 && (
        <div className="text-xs text-muted">No agent types returned from the catalog yet.</div>
      )}
      <div className="ml-auto text-[10px] text-muted shrink-0">
        Tools &amp; edges: WIP
      </div>
    </div>
  );
}
