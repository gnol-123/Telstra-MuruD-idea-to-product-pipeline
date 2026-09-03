"use client";

import { useState } from "react";
import { TabId } from "@/lib/types";
import TopNav from "./TopNav";
import ChatPanel from "./ChatPanel";
import CanvasPanel from "./CanvasPanel";

/* activeTAb react state */

export default function Workspace() {
  const [activeTab, setActiveTab] = useState<TabId>("Project Idea");
  const [resetKey, setResetKey] = useState(0);

  return (
    <div key={resetKey} className="h-screen flex flex-col bg-bg text-text">
      <TopNav
        activeTab={activeTab}
        onSelect={setActiveTab}
        onReset={() => setResetKey((k) => k + 1)}
      />
      <div className="flex-1 flex min-h-0">
        <ChatPanel activeTab={activeTab} />
        <CanvasPanel activeTab={activeTab} />
      </div>
    </div>
  );
}
