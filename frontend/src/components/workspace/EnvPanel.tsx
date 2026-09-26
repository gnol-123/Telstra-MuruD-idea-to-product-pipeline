"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EnvironmentFileEntry, EnvironmentNode, EnvironmentPreviewEntry, ProjectNode, isAgentNode } from "@/lib/types";
import {
  ApiError,
  fetchEnvironmentArchive,
  fetchEnvironmentFileBlob,
  listEnvironmentFiles,
  listEnvironmentPreviews,
  listManyEnvironmentFiles,
  readEnvironmentFile,
  serveEnvironmentPath,
} from "@/lib/api";
import { WORKSPACE_ROOT, basename, isImage, saveBlob } from "@/lib/files";
import { ENV_ICON } from "../NodeCard";
import FileTree, { DirState } from "./FileTree";
import CodeView, { OpenFile, ToolbarBtn } from "./CodeView";
import { StatusPill } from "./WorkspaceWindow";

// Chat's right-hand panel: previews an agent published, its files, one viewer.

const LIVE_INTERVAL_MS = 4000;
const MAX_LIVE_DIRS = 19;
const POLL_MS = 1500;
const POLL_LIMIT_MS = 30_000;
const NO_CHANGES = new Set<string>();
const noop = () => {};

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";

type FetchMode = "mount" | "turn" | "publish" | "quiet";

export default function EnvPanel({
  projectId,
  agentId,
  env,
  envs,
  nodes,
  open,
  turnKey,
  publishKey,
  onOpen,
  onCollapse,
  onSwitchEnv,
  onOpenFull,
}: {
  projectId: string;
  agentId: string;
  env: EnvironmentNode;
  // This agent's environments; a switcher shows when there's more than one.
  envs: EnvironmentNode[];
  nodes: ProjectNode[];
  // Collapsed still mounts, so new previews can pop it open.
  open: boolean;
  // Bumped after every turn / on a publish_preview tool result.
  turnKey: number;
  publishKey: number;
  onOpen: () => void;
  onCollapse: () => void;
  onSwitchEnv: (id: string) => void;
  onOpenFull: (envId: string, path: string) => void;
}) {
  const ready = env.status === "ready";
  const mine = `${WORKSPACE_ROOT}/${agentId}`;
  const agentNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const n of nodes) if (isAgentNode(n)) m[n.id] = n.name;
    return m;
  }, [nodes]);
  // Agent folder ids read as agent names; port only as a last resort.
  const label = (p: EnvironmentPreviewEntry) => (p.title ? agentNames[p.title] ?? p.title : `Port ${p.port}`);

  const [err, setErr] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set());

  // -- previews ---------------------------------------------------------------
  const [previews, setPreviews] = useState<EnvironmentPreviewEntry[] | null>(null);
  const [previewsErr, setPreviewsErr] = useState<string | null>(null);
  const [pick, setPick] = useState<{ id: string; path: string | null } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [frameLoading, setFrameLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const seen = useRef<Set<string> | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // -- files ------------------------------------------------------------------
  const [scope, setScope] = useState<"me" | "all">("me");
  const root = scope === "me" ? mine : WORKSPACE_ROOT;
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [file, setFile] = useState<OpenFile | null>(null);
  const liveRef = useRef({ root, expanded, file });
  liveRef.current = { root, expanded, file };

  function setBusy(path: string, on: boolean) {
    setBusyPaths((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function selectPreview(id: string, path: string | null = null) {
    setFile(null);
    setStalled(false);
    setPick({ id, path });
  }

  // mount: pick the newest published quietly. publish: pick it and open.
  // turn: open only for a published id not seen before.
  async function fetchPreviews(mode: FetchMode) {
    let list: EnvironmentPreviewEntry[];
    try {
      list = (await listEnvironmentPreviews(projectId, env.id)).previews;
    } catch (e) {
      setPreviewsErr(errText(e, "Could not load previews"));
      return;
    }
    setPreviewsErr(null);
    setPreviews(list);
    const published = list.filter((p) => p.published);
    const prev = seen.current;
    seen.current = new Set(published.map((p) => p.id));
    const target =
      mode === "turn" ? (prev ? published.find((p) => !prev.has(p.id)) : undefined) : mode === "quiet" ? undefined : published[0];
    if (!target) return;
    if (mode === "mount") setPick((p) => p ?? { id: target.id, path: null });
    else {
      selectPreview(target.id);
      onOpenRef.current();
    }
  }

  // Ready at mount: quiet pick. Came up mid-turn: treat like a publish.
  const readyAtMount = useRef(ready);
  useEffect(() => {
    if (ready) fetchPreviews(readyAtMount.current ? "mount" : "publish");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const firstTurn = useRef(turnKey);
  useEffect(() => {
    if (turnKey !== firstTurn.current && ready) fetchPreviews("turn");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnKey]);

  // A publish means the sandbox is up, even if the node hasn't caught up.
  const firstPublish = useRef(publishKey);
  useEffect(() => {
    if (publishKey !== firstPublish.current) fetchPreviews("publish");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishKey]);

  const current = pick ? previews?.find((p) => p.id === pick.id) : undefined;
  const waiting = !!pick && !current?.live;
  const path = pick?.path ?? current?.path ?? "/";
  const src = current?.live ? `${current.url.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}` : null;

  // Selected preview not live yet: poll, give up after 30s.
  useEffect(() => {
    if (!waiting || stalled) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) setStalled(true);
      else fetchPreviews("quiet");
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, stalled, pick?.id]);

  useEffect(() => setFrameLoading(true), [src, reloadKey]);

  // -- files ------------------------------------------------------------------

  async function loadDir(p: string) {
    setDirs((d) => ({ ...d, [p]: { entries: d[p]?.entries ?? null, loading: true, error: null } }));
    try {
      const r = await listEnvironmentFiles(projectId, env.id, p);
      setDirs((d) => ({ ...d, [p]: { entries: r.entries, loading: false, error: null } }));
    } catch (e) {
      setDirs((d) => ({ ...d, [p]: { entries: d[p]?.entries ?? null, loading: false, error: errText(e, "Could not list this folder") } }));
    }
  }

  useEffect(() => {
    if (open && ready && !dirs[root]) loadDir(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, root]);

  function toggleDir(p: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else {
        next.add(p);
        if (!dirs[p]?.entries) loadDir(p);
      }
      return next;
    });
  }

  async function openFile(entry: { path: string; name: string; size: number; modified?: string | null }, reload = false) {
    const { path: p, name } = entry;
    const meta = { size: entry.size, modified: entry.modified ?? null };
    if (!reload) {
      setPick(null);
      setFile({
        path: p,
        name,
        kind: isImage(name) ? "image" : "text",
        loading: true,
        error: null,
        content: "",
        truncated: false,
        imageUrl: null,
        ...meta,
        draft: null,
        saving: false,
        reloadedAt: null,
      });
    }
    const apply = (patch: Partial<OpenFile>) =>
      setFile((f) => (f?.path === p ? { ...f, ...patch, ...meta, loading: false, reloadedAt: reload ? Date.now() : f.reloadedAt } : f));
    try {
      if (isImage(name)) {
        apply({ imageUrl: URL.createObjectURL(await fetchEnvironmentFileBlob(projectId, env.id, p)) });
      } else {
        const f = await readEnvironmentFile(projectId, env.id, p);
        apply({ kind: "text", error: null, content: f.content, truncated: f.truncated });
      }
    } catch (e) {
      const binary = e instanceof ApiError && e.status === 415;
      apply(binary ? { kind: "binary", error: null } : { error: errText(e, "Could not read this file") });
    }
  }

  // Revoke the previous image when it's replaced or the panel goes.
  useEffect(() => {
    const url = file?.imageUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [file?.imageUrl]);

  // Live loop: re-read open folders; reload the open file if it moved.
  useEffect(() => {
    if (!open || !ready) return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const { root, expanded, file } = liveRef.current;
      const paths = [root, ...[...expanded].filter((p) => p.startsWith(root + "/")).slice(-MAX_LIVE_DIRS)];
      try {
        const r = await listManyEnvironmentFiles(projectId, env.id, paths);
        setDirs((d) => {
          const next = { ...d };
          for (const l of r.listings) {
            next[l.path] = l.entries
              ? { entries: l.entries, loading: false, error: null }
              : { entries: null, loading: false, error: l.error ?? "Could not list this folder" };
          }
          return next;
        });
        if (file && !file.loading) {
          const e = r.listings.flatMap((l) => l.entries ?? []).find((x: EnvironmentFileEntry) => x.path === file.path);
          if (e && (e.size !== file.size || (e.modified ?? null) !== file.modified)) openFile(e, true);
        }
      } catch {
        // Sandbox hiccup: next tick.
      }
    }, LIVE_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready, env.id]);

  async function download(entry: { path: string; name: string; type: string }) {
    setBusy(entry.path, true);
    try {
      if (entry.type === "dir") {
        const blob = await fetchEnvironmentArchive(projectId, env.id, entry.path);
        const name = entry.path === WORKSPACE_ROOT ? `${slug(env.name)}-workspace` : slug(agentNames[entry.name] ?? entry.name);
        saveBlob(blob, `${name}.zip`);
      } else {
        saveBlob(await fetchEnvironmentFileBlob(projectId, env.id, entry.path), entry.name);
      }
    } catch (e) {
      setErr(errText(e, "Download failed"));
    } finally {
      setBusy(entry.path, false);
    }
  }

  // Static-serve an HTML file (or folder); it then shows up in PREVIEWS.
  async function serve(p: string) {
    setBusy(p, true);
    try {
      const r = await serveEnvironmentPath(projectId, env.id, p);
      selectPreview(String(r.port), r.open_url.slice(r.url.length) || "/");
      await fetchPreviews("quiet");
    } catch (e) {
      setErr(errText(e, "Could not start a server"));
    } finally {
      setBusy(p, false);
    }
  }

  if (!open) return null;

  const mineMissing = scope === "me" && !!dirs[mine]?.error && !dirs[mine]?.entries;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-modal max-[900px]:absolute max-[900px]:inset-0 max-[900px]:z-10">
      {/* header */}
      <div className="flex-none flex items-center gap-2 px-3 h-[48px] border-b border-white/[0.09]">
        <button
          onClick={() => setRailOpen((o) => !o)}
          title={railOpen ? "Hide previews and files" : "Show previews and files"}
          className={`w-[26px] h-[26px] rounded-md border text-[11px] ${
            railOpen ? "border-accent/45 text-accent bg-accent/10" : "border-white/[0.14] text-white/50 hover:text-text"
          }`}
        >
          ☰
        </button>
        <span className="text-green text-sm">{ENV_ICON}</span>
        {envs.length > 1 ? (
          <select
            value={env.id}
            onChange={(e) => onSwitchEnv(e.target.value)}
            aria-label="Environment"
            className="bg-transparent text-[12.5px] font-semibold outline-none cursor-pointer max-w-[180px] truncate"
          >
            {envs.map((e) => (
              <option key={e.id} value={e.id} className="bg-panel2">
                {e.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[12.5px] font-semibold truncate">{env.name}</span>
        )}
        <StatusPill status={env.status} />
        <div className="ml-auto flex items-center gap-1.5">
          {ready && (
            <button
              onClick={() => download({ path: WORKSPACE_ROOT, name: "workspace", type: "dir" })}
              disabled={busyPaths.has(WORKSPACE_ROOT)}
              title="Whole workspace, code only (skips node_modules, .git, .venv)"
              className="text-[10.5px] px-2.5 py-[5px] rounded-md bg-accent hover:bg-[#5eeaf6] text-[#00191d] font-semibold whitespace-nowrap disabled:opacity-60"
            >
              {busyPaths.has(WORKSPACE_ROOT) ? "Zipping…" : "⤓ Download .zip"}
            </button>
          )}
          <button
            onClick={() => onOpenFull(env.id, mine)}
            title="Terminal, editing and uploads"
            className="text-[10.5px] px-2.5 py-[5px] rounded-md border border-green/35 text-green hover:bg-green/10 whitespace-nowrap"
          >
            Open full workspace
          </button>
          <button
            onClick={onCollapse}
            title="Collapse"
            className="w-[26px] h-[26px] rounded-md border border-white/[0.14] text-white/[0.55] hover:text-text hover:border-white/30 text-[12px]"
          >
            »
          </button>
        </div>
      </div>

      {err && (
        <button
          onClick={() => setErr(null)}
          className="flex-none text-left px-3 py-1.5 text-[11px] text-red-300 bg-red-500/[0.07] border-b border-red-400/20"
        >
          {err}
        </button>
      )}

      {!ready ? (
        <div className="flex-1 grid place-items-center p-6 text-center">
          <div>
            <div className="text-[13px] text-white/80">Environment is {env.status}</div>
            <div className="mt-1.5 text-[11px] text-white/40">It starts on the agent&apos;s first command.</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {/* rail */}
          {railOpen && (
            <aside className="flex-none w-[220px] border-r border-white/[0.08] flex flex-col min-h-0 bg-black/40">
              <div className="flex-none flex items-center px-3 h-[30px] text-[9.5px] tracking-[0.11em] uppercase text-white/35">
                Previews
                <button onClick={() => fetchPreviews("quiet")} title="Refresh" className="ml-auto text-[11px] text-white/40 hover:text-text">
                  ⟳
                </button>
              </div>
              <div className="flex-none max-h-[40%] overflow-y-auto pb-1.5 border-b border-white/[0.07]">
                {previewsErr && (
                  <div className="px-3 py-1 text-[10.5px] text-red-300/80 break-words">
                    {previewsErr}{" "}
                    <button onClick={() => fetchPreviews("quiet")} className="underline hover:text-red-200">
                      Retry
                    </button>
                  </div>
                )}
                {previewsErr && previews === null ? null : previews === null ? (
                  <div className="px-3 py-1 text-[10.5px] text-white/30">Loading…</div>
                ) : previews.length === 0 ? (
                  <div className="px-3 py-1 text-[10.5px] text-white/30">Nothing served yet</div>
                ) : (
                  previews.map((p) => {
                    const on = pick?.id === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => selectPreview(p.id)}
                        title={`${p.url} (port ${p.port})`}
                        className={`w-full flex items-center gap-2 px-3 h-[25px] text-[11.5px] text-left ${
                          on ? "bg-accent/[0.11] text-text" : "text-white/[0.72] hover:bg-white/[0.04]"
                        }`}
                      >
                        {p.live ? (
                          <span className="flex-none w-[6px] h-[6px] rounded-full bg-green anim-softpulse" />
                        ) : (
                          <span className="flex-none w-[9px] h-[9px] rounded-full border border-white/25 border-t-accent animate-spin" />
                        )}
                        <span className="truncate min-w-0">{label(p)}</span>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="flex-none flex items-center gap-1.5 px-2.5 pt-2">
                <span className="text-[9.5px] tracking-[0.11em] uppercase text-white/35 mr-auto">Files</span>
                {(["me", "all"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    title={s === "me" ? "This agent's folder" : "The whole workspace"}
                    className={`text-[10px] px-1.5 py-px rounded border ${
                      scope === s ? "border-accent/45 text-accent bg-accent/10" : "border-white/[0.12] text-white/45 hover:text-text"
                    }`}
                  >
                    {s === "me" ? "mine" : "all"}
                  </button>
                ))}
              </div>
              <div className="flex-none px-2.5 py-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter files…"
                  aria-label="Filter files"
                  className="w-full bg-white/[0.03] border border-white/[0.1] rounded-md px-2.5 py-1 text-[11px] outline-none focus:border-accent/45"
                />
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden" role="tree">
                {mineMissing ? (
                  <div className="px-3 py-1 text-[10.5px] text-white/30">No files from this agent yet.</div>
                ) : (
                  <FileTree
                    root={root}
                    dirs={dirs}
                    expanded={expanded}
                    selected={file?.path ?? null}
                    changed={NO_CHANGES}
                    showHidden={false}
                    filter={filter}
                    agentNames={agentNames}
                    busyPaths={busyPaths}
                    onToggle={toggleDir}
                    onOpen={(e) => openFile(e)}
                    onDownload={(e) => download(e)}
                    onPreview={(e) => serve(e.path)}
                  />
                )}
              </div>
            </aside>
          )}

          {/* viewer */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0 bg-[#05080a]">
            {file ? (
              <CodeView
                file={file}
                agentNames={agentNames}
                downloading={busyPaths.has(file.path)}
                onDraftChange={noop}
                onSave={noop}
                onCancelEdit={noop}
                onDownload={() => download({ path: file.path, name: file.name, type: "file" })}
                onPreview={() => serve(file.path)}
              />
            ) : pick ? (
              <>
                <div className="flex-none flex items-center gap-2 px-3 h-[34px] border-b border-white/[0.07] text-[11px]">
                  <span className="text-text truncate">{current ? label(current) : "Starting preview"}</span>
                  <span className="font-mono text-[10px] text-white/35 truncate">{path}</span>
                  <div className="ml-auto flex-none flex items-center gap-1">
                    <ToolbarBtn onClick={() => setReloadKey((k) => k + 1)} disabled={!src} title="Reload">
                      ⟳
                    </ToolbarBtn>
                    {src && (
                      <a
                        href={src}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in a new tab"
                        className="whitespace-nowrap text-[10.5px] px-2 py-[3px] rounded-[5px] border border-white/[0.12] text-white/60 hover:text-text hover:border-white/30"
                      >
                        ↗
                      </a>
                    )}
                    <ToolbarBtn onClick={() => setPick(null)} title="Close">
                      ×
                    </ToolbarBtn>
                  </div>
                </div>
                <div className="relative flex-1 min-h-0">
                  {src ? (
                    <iframe
                      key={`${reloadKey}:${src}`}
                      src={src}
                      title={current ? label(current) : "Preview"}
                      onLoad={() => setFrameLoading(false)}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                      className="w-full h-full border-0 bg-white"
                    />
                  ) : stalled ? (
                    <div className="h-full grid place-items-center text-center p-6">
                      <div>
                        <div className="text-[13px] text-white/80">Not responding</div>
                        <div className="mt-1.5 text-[11px] text-white/40">Nothing is listening on :{current?.port ?? pick.id}.</div>
                        <button
                          onClick={() => setStalled(false)}
                          className="mt-3 text-[11px] px-3 py-1.5 rounded-md border border-accent/40 text-accent bg-accent/5 hover:bg-accent/10"
                        >
                          Retry
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {(!src && !stalled) || (src && frameLoading) ? (
                    <div className="absolute inset-0 grid place-items-center bg-[#05080a]/80">
                      <span className="w-5 h-5 rounded-full border-2 border-white/20 border-t-accent animate-spin" />
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="flex-1 grid place-items-center p-6 text-center">
                <div className="max-w-[280px] text-[11.5px] text-white/40 leading-relaxed">
                  Pick a preview or a file. Previews the agent publishes open here on their own.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
