import { CANVAS_TITLE } from "@/lib/mockData";
import { TabId } from "@/lib/types";
import IdeaCanvas from "./canvas/IdeaCanvas";
import ResearchCanvas from "./canvas/ResearchCanvas";
import SlidesCanvas from "./canvas/SlidesCanvas";
import DesignCanvas from "./canvas/DesignCanvas";
import CodeCanvas from "./canvas/CodeCanvas";

/* PICKS WHICH OF THE 5 CANVAS COMPONENTS TO SHOW*/

export default function CanvasPanel({ activeTab }: { activeTab: TabId }) {
  const [title, badge] = CANVAS_TITLE[activeTab];

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="h-12 px-5 flex items-center gap-2 border-b border-border shrink-0">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-[10px] text-accent border border-accent/30 rounded px-1.5 py-0.5">
          {badge}
        </span>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {activeTab === "Project Idea" && <IdeaCanvas />}
        {activeTab === "Market Research" && <ResearchCanvas />}
        {activeTab === "Slides" && <SlidesCanvas />}
        {activeTab === "UI Design" && <DesignCanvas />}
        {activeTab === "Code" && <CodeCanvas />}
      </div>
    </div>
  );
}
