"use client";

import { useState } from "react";
import { AGENT_NAME, PROMPT_PLACEHOLDER, THREADS } from "@/lib/mockData";
import { TabId } from "@/lib/types";

/*THE LEFT HAND PANEL, shows the agent for the current tab */

export default function ChatPanel({ activeTab }: { activeTab: TabId }) {
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const messages = THREADS[activeTab];

  function handleSend() {
    if (!draft.trim()) return;
    // TODO: call sendToAgent(activeTab, { message: draft, sourceIds: [...selected] })
    // once the FastAPI backend endpoints exist. For now this is a visual-only stub.
    setDraft("");
  }

  return (
    <div className="w-[420px] shrink-0 border-r border-border flex flex-col bg-panel">
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border">
        <span className="text-accent">✦</span>
        <span className="text-sm font-medium">{AGENT_NAME[activeTab]}</span>
        <span className="ml-auto text-[10px] text-accent flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block" />
          ONLINE
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div className="text-[10px] text-muted mb-1">
              {m.who} · {m.time}
            </div>
            <div
              className={`inline-block max-w-[320px] text-sm px-3 py-2 rounded-lg text-left ${
                m.role === "user"
                  ? "bg-accent/10 border border-accent/30"
                  : "bg-panel2 border border-border"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={PROMPT_PLACEHOLDER[activeTab]}
            className="flex-1 bg-panel2 border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-accent/50"
          />
          <button
            onClick={handleSend}
            className="bg-accent/15 text-accent border border-accent/40 rounded-md px-3 py-2 text-sm hover:bg-accent/25"
          >
            Send →
          </button>
        </div>
      </div>
    </div>
  );
}
