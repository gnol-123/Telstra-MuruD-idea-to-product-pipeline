"use client";

import { AgentNode } from "@/lib/types";

export default function NodeCard({
  node,
  selected,
  onSelect,
  onDragEnd,
}: {
  node: AgentNode;
  selected: boolean;
  onSelect: () => void;
  onDragEnd: (x: number, y: number) => void;
}) {
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = node.position_x ?? 0;
    const originY = node.position_y ?? 0;
    let latestX = originX;
    let latestY = originY;

    const card = e.currentTarget;

    function onMove(ev: PointerEvent) {
      latestX = originX + (ev.clientX - startX);
      latestY = originY + (ev.clientY - startY);
      card.style.left = `${latestX}px`;
      card.style.top = `${latestY}px`;
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // One PATCH per gesture on release, per API.md's guidance — not per
      // pixel while dragging.
      onDragEnd(latestX, latestY);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    onSelect();
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      style={{ left: node.position_x ?? 0, top: node.position_y ?? 0 }}
      className={`absolute w-56 cursor-grab active:cursor-grabbing bg-panel border rounded-lg p-3 select-none ${
        selected ? "border-accent" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-accent">◆</span>
        <span className="text-sm font-medium truncate">{node.name}</span>
      </div>
      <div className="text-[10px] text-muted">{node.agent_slug}</div>
      <div className="text-[10px] text-muted mt-1">
        Tool policy: <span className="text-text/70">{node.tool_policy}</span>
      </div>
    </div>
  );
}
