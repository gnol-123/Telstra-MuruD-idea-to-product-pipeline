"use client";

import { TABS } from "@/lib/mockData";
import { TabId } from "@/lib/types";

/* top bar*/

export default function TopNav({
  activeTab,
  onSelect,
  onReset,
}: {
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-panel px-4 h-14 shrink-0">
      <div className="flex items-center gap-2 font-medium text-sm">
        <span className="w-6 h-6 rounded bg-accent/20 border border-accent/40 flex items-center justify-center text-accent text-xs">
          ◆
        </span>
        Telstra Muru-D — Team 2
      </div>

      <div className="flex items-center gap-1">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => onSelect(tab)}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              tab === activeTab
                ? "bg-accent/10 text-accent border border-accent/40"
                : "text-muted hover:text-text border border-transparent"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <button
        onClick={onReset}
        className="text-xs text-muted hover:text-text border border-border rounded-md px-3 py-1.5"
      >
        ↺ Reset demo
      </button>
    </div>
  );
}
