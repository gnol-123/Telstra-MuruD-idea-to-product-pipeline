"use client";

import { useState } from "react";
import { ProjectNode, ToolType } from "@/lib/types";
import { createToolNode, ApiError } from "@/lib/api";

export default function ToolConfigModal({
  projectId,
  toolType,
  position,
  onCreated,
  onCancel,
}: {
  projectId: string;
  toolType: ToolType;
  position: { x: number; y: number };
  onCreated: (node: ProjectNode) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(toolType.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = toolType.config_schema.fields ?? [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    for (const f of fields) {
      if (f.required && !values[f.key]?.trim()) {
        setError(`${f.label} is required.`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const config: Record<string, string> = {};
      for (const f of fields) {
        if (values[f.key]?.trim()) config[f.key] = values[f.key].trim();
      }
      const node = await createToolNode(projectId, toolType.slug, {
        name: name.trim() || toolType.name,
        config,
        position_x: position.x,
        position_y: position.y,
      });
      onCreated(node);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm grid place-items-center p-9"
      onClick={onCancel}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-panel border border-accent/30 rounded-2xl p-6 space-y-4 shadow-2xl"
      >
        <div>
          <div className="text-sm font-semibold">Add {toolType.name}</div>
          <div className="text-xs text-muted mt-1">{toolType.description}</div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] text-muted uppercase tracking-wide">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-panel2 border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-accent/50"
          />
        </div>

        {toolType.auth_kind === "oauth2" ? (
          <div className="text-xs text-muted leading-relaxed border border-dashed border-white/15 rounded-md p-3">
            This tool authenticates with a Connect button rather than typed
            credentials. It will be added in a pending state — open it afterwards
            to connect the account.
          </div>
        ) : (
          fields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-[10px] text-muted uppercase tracking-wide">
                {f.label}
                {f.required && <span className="text-amber"> *</span>}
              </label>
              <input
                type={f.type === "password" ? "password" : "text"}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={toolType.config_schema.default_url && f.key === "url" ? toolType.config_schema.default_url : undefined}
                className="w-full bg-panel2 border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-accent/50"
              />
              {f.help && <div className="text-[10px] text-muted">{f.help}</div>}
            </div>
          ))
        )}

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 text-xs text-muted hover:text-text border border-border rounded-md py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 bg-accent text-black font-medium rounded-md py-2 text-xs disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add tool"}
          </button>
        </div>
      </form>
    </div>
  );
}
