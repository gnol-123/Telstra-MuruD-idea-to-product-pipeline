"use client";

import { useEffect, useState } from "react";
import { listProjects, createProject, deleteProject, logout, ApiError } from "@/lib/api";
import { Project } from "@/lib/types";
import { Brand } from "./Brand";

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
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  async function handleDelete(project: Project) {
    setDeletingId(project.id);
    setError(null);
    try {
      await deleteProject(project.id);
      setProjects((p) => (p ?? []).filter((x) => x.id !== project.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete project");
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      <header className="flex-none flex items-center gap-4 px-5 h-[60px] border-b border-white/[0.09]">
        <Brand />
        <button
          onClick={async () => {
            await logout();
            onLoggedOut();
          }}
          className="ml-auto bg-transparent border border-white/[0.14] text-white/60 hover:text-text hover:border-white/30 rounded-lg px-3 py-2 text-xs"
        >
          Log out
        </button>
      </header>

      <div
        className="flex-1 overflow-auto"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,.06) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      >
      <div className="max-w-2xl mx-auto px-6 py-10">
      <div className="mb-6">
        <div className="text-lg font-semibold tracking-[-0.01em]">Your projects</div>
        <div className="text-xs text-white/40 mt-1">Each project is its own canvas of agents, tools and sandboxes.</div>
      </div>

      <form onSubmit={handleCreate} className="flex gap-2 mb-6">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name…"
          className="flex-1 bg-white/[0.03] border border-white/[0.13] rounded-lg px-3.5 py-2.5 text-sm outline-none focus:border-accent/50 placeholder:text-white/30"
        />
        <button className="bg-accent hover:bg-[#5eeaf6] text-[#00191d] text-sm font-semibold rounded-lg px-5">
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
            <div
              key={p.id}
              className="w-full flex items-center gap-3 bg-white/[0.022] backdrop-blur border border-white/[0.13] rounded-[13px] px-4 py-3.5 hover:border-accent/45 hover:bg-accent/[0.03] transition-colors"
            >
              <div className="flex-none w-[30px] h-[30px] rounded-lg border border-white/[0.18] grid place-items-center text-white/60 text-[13px]">
                ❖
              </div>
              <button onClick={() => onOpen(p)} className="flex-1 min-w-0 text-left">
                <div className="text-sm font-medium">{p.name}</div>
                {p.description && (
                  <div className="text-xs text-muted mt-0.5">{p.description}</div>
                )}
              </button>

              {confirmingId === p.id ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-muted">Delete? Cascades to its whole canvas.</span>
                  <button
                    onClick={() => handleDelete(p)}
                    disabled={deletingId === p.id}
                    className="text-[11px] text-red-400 border border-red-400/40 rounded-md px-2 py-1 disabled:opacity-50"
                  >
                    {deletingId === p.id ? "Deleting…" : "Delete"}
                  </button>
                  <button
                    onClick={() => setConfirmingId(null)}
                    className="text-[11px] text-muted hover:text-text px-1"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingId(p.id)}
                  title="Delete project"
                  className="shrink-0 text-white/30 hover:text-red-400 text-sm px-1"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
