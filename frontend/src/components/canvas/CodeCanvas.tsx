"use client";

import { useState } from "react";
import { FILES, CODE_SAMPLE } from "@/lib/mockData";

export default function CodeCanvas() {
  const [active, setActive] = useState(FILES[1].id);
  const activeFile = FILES.find((f) => f.id === active)!;

  return (
    <div className="flex h-full border border-border rounded-lg overflow-hidden">
      <div className="w-56 shrink-0 border-r border-border bg-panel2 p-2 text-sm">
        <div className="text-[11px] text-muted px-2 py-1">sidekick-web / src</div>
        {FILES.map((f) => (
          <button
            key={f.id}
            onClick={() => setActive(f.id)}
            className={`w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-md ${
              f.id === active ? "bg-accent/10 text-accent" : "text-muted hover:text-text"
            }`}
          >
            <span className="truncate flex-1">{f.name}</span>
            {f.changed && <span className="text-[9px] text-accent">M</span>}
          </button>
        ))}
      </div>
      <div className="flex-1 flex flex-col">
        <div className="h-10 flex items-center px-3 border-b border-border text-xs text-muted">
          {activeFile.name} · main branch
        </div>
        <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-muted leading-relaxed">
          {CODE_SAMPLE}
        </pre>
      </div>
    </div>
  );
}
