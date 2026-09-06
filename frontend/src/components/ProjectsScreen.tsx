"use client";

import { useEffect, useState } from "react";
import { listProjects, createProject, logout } from "@/lib/api";
import { Project } from "@/lib/types";

export default function ProjectsScreen({
  onOpen,
  onLoggedOut,
}: {
  onOpen: (project: Project) => void;
  onLoggedOut: () => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const project = await createProject(name);
      setProjects((p) => [...(p ?? []), project]);
      setName("");
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="h-screen bg-bg text-text p-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="text-lg font-semibold">Your projects</div>
        <button
          onClick={async () => {
            await logout();
            onLoggedOut();
          }}
          className="text-xs text-muted hover:text-text border border-border rounded-md px-3 py-1.5"
        >
          Log out
        </button>
      </div>

      <form onSubmit={handleCreate} className="flex gap-2 mb-6">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name…"
          className="flex-1 bg-panel2 border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-accent/50"
        />
        <button className="bg-accent text-black text-sm font-medium rounded-md px-4">
          Create
        </button>
      </form>

      {error && <div className="text-xs text-red-400 mb-4">{error}</div>}

      {projects === null ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="text-sm text-muted">No projects yet — create one above.</div>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => onOpen(p)}
              className="w-full text-left bg-panel border border-border rounded-lg px-4 py-3 hover:border-accent/40"
            >
              <div className="text-sm font-medium">{p.name}</div>
              {p.description && (
                <div className="text-xs text-muted mt-0.5">{p.description}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
