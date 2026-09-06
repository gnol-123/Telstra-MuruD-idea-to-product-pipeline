"use client";

import { useEffect, useState } from "react";
import { Project, AgentType, AgentNode } from "@/lib/types";
import { getAgentTypes, listNodes, createNode, updateNode } from "@/lib/api";
import Palette from "./Palette";
import NodeCard from "./NodeCard";
import Inspector from "./Inspector";

export default function MeshCanvas({
  project,
  onBack,
}: {
  project: Project;
  onBack: () => void;
}) {
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [nodes, setNodes] = useState<AgentNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAgentTypes().then(setAgentTypes).catch((e) => setError(e.message));
    listNodes(project.id).then(setNodes).catch((e) => setError(e.message));
  }, [project.id]);

  async function handleAdd(agentSlug: string) {
    try {
      // Simple cascade so new nodes don't stack exactly on top of each other.
      const offset = nodes.length * 40;
      const node = await createNode(project.id, agentSlug, {
        position_x: 120 + offset,
        position_y: 100 + offset,
      });
      setNodes((n) => [...n, node]);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleDragEnd(node: AgentNode, x: number, y: number) {
    setNodes((prev) =>
      prev.map((n) => (n.id === node.id ? { ...n, position_x: x, position_y: y } : n))
    );
    try {
      await updateNode(project.id, node.id, { position_x: x, position_y: y });
    } catch (e: any) {
      setError(e.message);
    }
  }

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      <header className="flex items-center gap-4 px-5 h-14 border-b border-border shrink-0">
        <button onClick={onBack} className="text-xs text-muted hover:text-text">
          ← Projects
        </button>
        <div className="text-sm font-medium">{project.name}</div>
        <div className="ml-auto text-[10px] text-muted">
          {nodes.length} node{nodes.length === 1 ? "" : "s"}
        </div>
      </header>

      <Palette agentTypes={agentTypes} onAdd={handleAdd} />

      {error && (
        <div className="px-5 py-2 text-xs text-red-400 border-b border-border">{error}</div>
      )}

      <div className="flex-1 flex min-h-0">
        <main
          className="flex-1 relative overflow-auto"
          style={{
            backgroundImage: "radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        >
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={node.id === selectedId}
              onSelect={() => setSelectedId(node.id)}
              onDragEnd={(x, y) => handleDragEnd(node, x, y)}
            />
          ))}
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
              Add an agent from the palette above to get started.
            </div>
          )}
        </main>
        <Inspector node={selectedNode} />
      </div>
    </div>
  );
}
