"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EnvironmentFileEntry, EnvironmentNode, EnvironmentPort, ProjectNode, isAgentNode } from "@/lib/types";
import {
  ApiError,
  fetchEnvironmentArchive,
  fetchEnvironmentFileBlob,
  getEnvironmentPreview,
  listEnvironmentFiles,
  listEnvironmentPorts,
  listManyEnvironmentFiles,
  readEnvironmentFile,
  serveEnvironmentPath,
  startEnvironment,
  writeEnvironmentFile,
} from "@/lib/api";
import { WORKSPACE_ROOT, basename, dirname, isImage, joinPath, saveBlob, timeAgo } from "@/lib/files";
import { ENV_ICON } from "../NodeCard";
import FileTree, { DirState } from "./FileTree";
import CodeView, { OpenFile, ToolbarBtn } from "./CodeView";
import PreviewPane, { Device, pickDefaultPort } from "./PreviewPane";
import TerminalPane from "./TerminalPane";

type View = "code" | "split" | "preview";

// How often the open folders and the port list are re-read while the
// window is visible. Each is one call on a held sandbox connection.
const LIVE_INTERVAL_MS = 4000;
// At most this many expanded folders are re-read per tick.
const MAX_LIVE_DIRS = 19;

const sig = (e: { size: number; modified?: string | null }) => `${e.size}|${e.modified ?? ""}`;

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
}

export default function WorkspaceWindow({
  projectId,
  envs,
  initialEnvId,
  initialPath,
  nodes,
  onNodeUpdated,
  onClose,
}: {
  projectId: string;
  // Every environment on the canvas; the header switches between them.
  envs: EnvironmentNode[];
  initialEnvId: string;
  // Folder to reveal on open — an agent's working directory, usually.
  initialPath?: string | null;
  nodes: ProjectNode[];
  onNodeUpdated: (node: ProjectNode) => void;
  onClose: () => void;
}) {
  const [envId, setEnvId] = useState(initialEnvId);
  const env = envs.find((e) => e.id === envId) ?? envs[0];

  // Esc closes — unless focus is in the terminal (vim needs Esc) or an editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest(".terminal-host") || el?.tagName === "TEXTAREA") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!env) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-black/[0.72] backdrop-blur-[3px] p-4 lg:p-6 anim-fadein" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`Workspace: ${env.name}`}
        className="w-full h-full bg-modal border border-green/[0.28] rounded-2xl shadow-[0_40px_120px_rgba(0,0,0,.85),0_0_70px_rgba(126,231,135,.06)] flex flex-col overflow-hidden anim-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <Workspace
          // A different environment is a different filesystem: start clean.
          key={env.id}
          projectId={projectId}
          env={env}
          envs={envs}
          initialPath={env.id === initialEnvId ? initialPath ?? null : null}
          nodes={nodes}
          onSwitchEnv={setEnvId}
          onNodeUpdated={onNodeUpdated}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

function Workspace({
  projectId,
  env,
  envs,
  initialPath,
  nodes,
  onSwitchEnv,
  onNodeUpdated,
  onClose,
}: {
  projectId: string;
  env: EnvironmentNode;
  envs: EnvironmentNode[];
  initialPath: string | null;
  nodes: ProjectNode[];
  onSwitchEnv: (id: string) => void;
  onNodeUpdated: (node: ProjectNode) => void;
  onClose: () => void;
}) {
  const ready = env.status === "ready";
  const agentNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const n of nodes) if (isAgentNode(n)) m[n.id] = n.name;
    return m;
  }, [nodes]);

  // -- explorer state ---------------------------------------------------------
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(initialPath);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Mirrors of state the live loop reads without re-subscribing every tick.
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // -- editor state -------------------------------------------------------------
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // -- preview state ------------------------------------------------------------
  const [view, setView] = useState<View>("code");
  const [ports, setPorts] = useState<EnvironmentPort[]>([]);
  const [manualPorts, setManualPorts] = useState<EnvironmentPort[]>([]);
  const [portsLoaded, setPortsLoaded] = useState(false);
  const [activePort, setActivePort] = useState<number | null>(null);
  const [previewPath, setPreviewPath] = useState("/");
  const [reloadKey, setReloadKey] = useState(0);
  const [device, setDevice] = useState<Device>("desktop");
  const [autoReload, setAutoReload] = useState(true);
  const [serving, setServing] = useState(false);
  const lastAutoReload = useRef(0);
  const choseViewOnce = useRef(false);

  // -- chrome -----------------------------------------------------------------
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [live, setLive] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [banner, setBanner] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [zipMenu, setZipMenu] = useState(false);
  const [, forceTick] = useState(0);

  const allPorts = useMemo(() => {
    const seen = new Set(ports.map((p) => p.port));
    return [...ports, ...manualPorts.filter((p) => !seen.has(p.port))];
  }, [ports, manualPorts]);

  const flash = useCallback((kind: "error" | "ok", text: string) => setBanner({ kind, text }), []);
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), banner.kind === "ok" ? 3500 : 8000);
    return () => clearTimeout(t);
  }, [banner]);

  // Relative times in the status bar and the "updated" badge age on their own.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  function setBusy(path: string, on: boolean) {
    setBusyPaths((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

  // -- loading folders ----------------------------------------------------------

  const loadDir = useCallback(
    async (path: string, quiet = false) => {
      if (!quiet) {
        setDirs((d) => ({ ...d, [path]: { entries: d[path]?.entries ?? null, loading: true, error: null } }));
      }
      try {
        const r = await listEnvironmentFiles(projectId, env.id, path);
        setDirs((d) => ({ ...d, [path]: { entries: r.entries, loading: false, error: null } }));
        return r.entries;
      } catch (e) {
        setDirs((d) => ({
          ...d,
          [path]: { entries: d[path]?.entries ?? null, loading: false, error: errText(e, "Could not list this folder") },
        }));
        return null;
      }
    },
    [projectId, env.id]
  );

  // First load: the root, then every folder down to the one we opened on.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      await loadDir(WORKSPACE_ROOT);
      const chain: string[] = [];
      if (initialPath && initialPath.startsWith(WORKSPACE_ROOT + "/")) {
        let p = initialPath;
        while (p.length > WORKSPACE_ROOT.length) {
          chain.unshift(p);
          p = dirname(p);
        }
      }
      for (const p of chain) {
        if (cancelled) return;
        const entries = await loadDir(p);
        if (entries === null) break;
        setExpanded((s) => new Set(s).add(p));
      }
      if (!cancelled) setLastRefresh(Date.now());
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, loadDir, initialPath]);

  // -- ports --------------------------------------------------------------------

  const refreshPorts = useCallback(async () => {
    try {
      const r = await listEnvironmentPorts(projectId, env.id);
      setPorts(r.ports);
      setPortsLoaded(true);
      return r.ports;
    } catch {
      setPortsLoaded(true);
      return null;
    }
  }, [projectId, env.id]);

  useEffect(() => {
    if (!ready) return;
    refreshPorts().then((found) => {
      // Open straight into a side-by-side view when something is running.
      if (!choseViewOnce.current && found && found.length > 0) {
        choseViewOnce.current = true;
        setView("split");
      }
    });
  }, [ready, refreshPorts]);

  // Keep a live port selected: the first preferred one, or none.
  useEffect(() => {
    if (activePort !== null && allPorts.some((p) => p.port === activePort)) return;
    setActivePort(pickDefaultPort(allPorts));
  }, [allPorts, activePort]);

  // -- opening files ------------------------------------------------------------

  const loadFile = useCallback(
    async (path: string, meta: { size: number; modified: string | null }, reason: "open" | "agent") => {
      const name = basename(path);
      if (isImage(name)) {
        try {
          const blob = await fetchEnvironmentFileBlob(projectId, env.id, path);
          const url = URL.createObjectURL(blob);
          setTabs((ts) =>
            ts.map((t) => {
              if (t.path !== path) return t;
              if (t.imageUrl) URL.revokeObjectURL(t.imageUrl);
              return { ...t, loading: false, imageUrl: url, size: meta.size, modified: meta.modified, reloadedAt: reason === "agent" ? Date.now() : t.reloadedAt };
            })
          );
        } catch (e) {
          setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, loading: false, error: errText(e, "Could not load the image") } : t)));
        }
        return;
      }
      try {
        const f = await readEnvironmentFile(projectId, env.id, path);
        setTabs((ts) =>
          ts.map((t) =>
            t.path === path
              ? {
                  ...t,
                  kind: "text",
                  loading: false,
                  error: null,
                  content: f.content,
                  truncated: f.truncated,
                  size: meta.size,
                  modified: meta.modified,
                  reloadedAt: reason === "agent" ? Date.now() : t.reloadedAt,
                }
              : t
          )
        );
      } catch (e) {
        const binary = e instanceof ApiError && e.status === 415;
        setTabs((ts) =>
          ts.map((t) =>
            t.path === path
              ? { ...t, loading: false, kind: binary ? "binary" : t.kind, error: binary ? null : errText(e, "Could not read this file") }
              : t
          )
        );
      }
    },
    [projectId, env.id]
  );

  function openFile(entry: EnvironmentFileEntry) {
    setSelected(entry.path);
    if (view === "preview") setView("split");
    if (tabsRef.current.some((t) => t.path === entry.path)) {
      setActive(entry.path);
      return;
    }
    const tab: OpenFile = {
      path: entry.path,
      name: entry.name,
      kind: isImage(entry.name) ? "image" : "text",
      loading: true,
      error: null,
      content: "",
      truncated: false,
      imageUrl: null,
      size: entry.size,
      modified: entry.modified ?? null,
      draft: null,
      saving: false,
      reloadedAt: null,
    };
    setTabs((ts) => [...ts, tab]);
    setActive(entry.path);
    loadFile(entry.path, { size: entry.size, modified: entry.modified ?? null }, "open");
  }

  function closeTab(path: string) {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (tab?.draft !== null && tab?.draft !== tab?.content && !window.confirm(`Discard unsaved changes to ${tab?.name}?`)) return;
    if (tab?.imageUrl) URL.revokeObjectURL(tab.imageUrl);
    const remaining = tabsRef.current.filter((t) => t.path !== path);
    setTabs(remaining);
    if (active === path) setActive(remaining.length ? remaining[remaining.length - 1].path : null);
  }

  // Revoke image URLs when the window closes.
  useEffect(
    () => () => {
      for (const t of tabsRef.current) if (t.imageUrl) URL.revokeObjectURL(t.imageUrl);
    },
    []
  );

  function toggleDir(path: string) {
    setSelected(path);
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirsRef.current[path]?.entries) loadDir(path);
      }
      return next;
    });
  }

  // -- the live loop --------------------------------------------------------------
  // Re-reads the open folders and ports. Anything whose size or mtime moved
  // flashes in the tree; an open tab reloads (unless it's being edited); and
  // the preview reloads, so an agent's edit shows up without touching
  // anything.

  const refreshAll = useCallback(
    async (manual = false) => {
      const paths = [WORKSPACE_ROOT, ...[...expandedRef.current].slice(-MAX_LIVE_DIRS)];
      const before = new Map<string, string>();
      for (const p of paths) for (const e of dirsRef.current[p]?.entries ?? []) before.set(e.path, sig(e));

      // One request for every open folder, not one each.
      let results: (EnvironmentFileEntry[] | null)[];
      try {
        const r = await listManyEnvironmentFiles(projectId, env.id, paths);
        results = r.listings.map((l) => l.entries);
        setDirs((d) => {
          const next = { ...d };
          for (const l of r.listings) {
            next[l.path] = l.entries
              ? { entries: l.entries, loading: false, error: null }
              : { entries: null, loading: false, error: l.error ?? "Could not list this folder" };
          }
          return next;
        });
      } catch {
        // Sandbox hiccup: keep what's on screen, try again next tick.
        return;
      }
      refreshPorts();
      setLastRefresh(Date.now());

      const moved = new Set<string>();
      const after = new Map<string, EnvironmentFileEntry>();
      results.forEach((entries) => {
        for (const e of entries ?? []) {
          after.set(e.path, e);
          const was = before.get(e.path);
          // New files count as changes too, except on a folder's first load.
          if (was !== sig(e) && (was !== undefined || before.size > 0)) moved.add(e.path);
        }
      });
      if (manual || moved.size === 0) return;

      setChanged(moved);
      setTimeout(() => setChanged(new Set()), 2600);

      for (const t of tabsRef.current) {
        const e = after.get(t.path);
        if (e && moved.has(t.path) && t.draft === null) loadFile(t.path, { size: e.size, modified: e.modified ?? null }, "agent");
      }
      if (autoReload && Date.now() - lastAutoReload.current > 1500) {
        lastAutoReload.current = Date.now();
        setReloadKey((k) => k + 1);
      }
    },
    [projectId, env.id, refreshPorts, loadFile, autoReload]
  );

  useEffect(() => {
    if (!ready || !live) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refreshAll();
    }, LIVE_INTERVAL_MS);
    return () => clearInterval(t);
  }, [ready, live, refreshAll]);

  // -- actions ------------------------------------------------------------------

  // Folder an action applies to: the selected folder, a selected file's
  // folder, else the one we opened on, else the root.
  function targetDir(): string {
    const sel = selected;
    if (sel) {
      const inDirs = Object.values(dirsRef.current).some((d) => d.entries?.some((e) => e.path === sel && e.type === "dir"));
      if (inDirs || sel === WORKSPACE_ROOT || dirsRef.current[sel]) return sel;
      return dirname(sel);
    }
    return initialPath ?? WORKSPACE_ROOT;
  }

  function zipName(path: string) {
    if (path === WORKSPACE_ROOT) return `${slug(env.name)}-workspace.zip`;
    const name = basename(path);
    return `${slug(agentNames[name] ?? name)}.zip`;
  }

  async function download(entry: { path: string; name: string; type: string }, includeDependencies = false) {
    setBusy(entry.path, true);
    try {
      if (entry.type === "dir") {
        const blob = await fetchEnvironmentArchive(projectId, env.id, entry.path, includeDependencies);
        saveBlob(blob, zipName(entry.path));
      } else {
        const blob = await fetchEnvironmentFileBlob(projectId, env.id, entry.path);
        saveBlob(blob, entry.name);
      }
    } catch (e) {
      flash("error", errText(e, "Download failed"));
    } finally {
      setBusy(entry.path, false);
    }
  }

  async function serve(path: string) {
    setServing(true);
    setBusy(path, true);
    try {
      const r = await serveEnvironmentPath(projectId, env.id, path);
      await refreshPorts();
      setManualPorts((m) => (m.some((p) => p.port === r.port) ? m : [...m, r]));
      setActivePort(r.port);
      const sub = r.open_url.slice(r.url.length) || "/";
      setPreviewPath(sub);
      setReloadKey((k) => k + 1);
      if (view === "code") setView("split");
      flash("ok", r.reused ? `Showing :${r.port}, already serving that folder.` : `Serving on :${r.port}.`);
    } catch (e) {
      flash("error", errText(e, "Could not start a server"));
    } finally {
      setServing(false);
      setBusy(path, false);
    }
  }

  async function openPort(port: number) {
    try {
      const r = await getEnvironmentPreview(projectId, env.id, port);
      setManualPorts((m) =>
        m.some((p) => p.port === port)
          ? m
          : [...m, { port, url: r.url, pid: null, process: "opened manually", command: "", local_only: false, serving: null }]
      );
      setActivePort(port);
      setPreviewPath("/");
    } catch (e) {
      flash("error", errText(e, "Could not open that port"));
    }
  }

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const dir = targetDir();
    setBusy(dir, true);
    let done = 0;
    try {
      for (const f of list) {
        await writeEnvironmentFile(projectId, env.id, joinPath(dir, f.name), f);
        done += 1;
      }
      flash("ok", `Uploaded ${done} file${done === 1 ? "" : "s"} to ${agentNames[basename(dir)] ?? basename(dir)}.`);
    } catch (e) {
      flash("error", `${done ? `Uploaded ${done}, then: ` : ""}${errText(e, "Upload failed")}`);
    } finally {
      setBusy(dir, false);
      await loadDir(dir, true);
      if (dir !== WORKSPACE_ROOT) setExpanded((s) => new Set(s).add(dir));
    }
  }

  async function save(path: string) {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.draft === null) return;
    const draft = tab.draft;
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, saving: true } : t)));
    try {
      const r = await writeEnvironmentFile(projectId, env.id, path, draft);
      setTabs((ts) =>
        ts.map((t) => (t.path === path ? { ...t, saving: false, content: draft, draft: null, size: r.size, modified: new Date().toISOString() } : t))
      );
      flash("ok", `Saved ${tab.name}.`);
      loadDir(dirname(path), true);
      if (autoReload) setReloadKey((k) => k + 1);
    } catch (e) {
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, saving: false } : t)));
      flash("error", errText(e, "Save failed"));
    }
  }

  // Ctrl/⌘+S saves the active editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && active) {
        const tab = tabsRef.current.find((t) => t.path === active);
        if (tab?.draft !== null && tab?.draft !== undefined) {
          e.preventDefault();
          save(active);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // save reads refs; re-binding on `active` is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function start() {
    setStarting(true);
    try {
      const updated = await startEnvironment(projectId, env.id);
      onNodeUpdated(updated);
      if (updated.status !== "ready") flash("error", updated.status_detail ?? `Environment is ${updated.status}.`);
    } catch (e) {
      flash("error", errText(e, "Could not start the environment"));
    } finally {
      setStarting(false);
    }
  }

  function toggleTerminal() {
    if (!terminalOpened) setTerminalOpened(true);
    setTerminalVisible((v) => !v);
  }

  // -- render -------------------------------------------------------------------

  const activeTab = tabs.find((t) => t.path === active) ?? null;
  const serveTarget = activeTab && activeTab.name.match(/\.html?$/i) ? activeTab.path : targetDir();
  const serveLabel =
    serveTarget === WORKSPACE_ROOT ? "the workspace" : agentNames[basename(serveTarget)] ?? basename(serveTarget);
  const dirtyCount = tabs.filter((t) => t.draft !== null && t.draft !== t.content).length;

  return (
    <>
      {/* header */}
      <div className="flex-none flex items-center gap-3 px-4 h-[54px] border-b border-white/[0.09]">
        <div className="w-8 h-8 rounded-lg border border-green/50 grid place-items-center text-green text-sm">{ENV_ICON}</div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {envs.length > 1 ? (
              <select
                value={env.id}
                onChange={(e) => onSwitchEnv(e.target.value)}
                aria-label="Environment"
                className="bg-transparent text-sm font-semibold outline-none cursor-pointer -ml-0.5 max-w-[220px] truncate"
              >
                {envs.map((e) => (
                  <option key={e.id} value={e.id} className="bg-panel2">
                    {e.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm font-semibold truncate">{env.name}</span>
            )}
            <StatusPill status={env.status} />
          </div>
          <div className="text-[10.5px] text-white/40 mt-0.5 truncate">
            Code preview · {env.runtime} sandbox · {env.role === "scratch" ? "shared by every agent" : "user environment"}
          </div>
        </div>

        {ready && (
          <div className="ml-4 flex p-[3px] border border-white/10 rounded-[9px]" role="tablist" aria-label="View">
            {(["code", "split", "preview"] as View[]).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`rounded-[7px] px-3 py-[5px] text-[11.5px] capitalize transition-colors ${
                  view === v ? "bg-accent/[0.14] text-accent font-semibold" : "text-white/50 hover:text-text"
                }`}
              >
                {v === "split" ? "Split" : v === "code" ? "‹› Code" : "▶ Preview"}
                {v === "preview" && allPorts.length > 0 && (
                  <span className="ml-1.5 inline-block w-[5px] h-[5px] rounded-full bg-green align-middle anim-softpulse" />
                )}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {ready && (
            <>
              <button
                onClick={toggleTerminal}
                className={`text-[11px] px-3 py-[7px] rounded-lg border transition-colors ${
                  terminalVisible ? "border-accent/45 text-accent bg-accent/10" : "border-white/[0.14] text-white/60 hover:text-text hover:border-white/30"
                }`}
              >
                ⌨ Terminal
              </button>
              <div className="relative flex">
                <button
                  onClick={() => download({ path: WORKSPACE_ROOT, name: "workspace", type: "dir" })}
                  disabled={busyPaths.has(WORKSPACE_ROOT)}
                  className="text-[11px] pl-3 pr-2.5 py-[7px] rounded-l-lg bg-primary hover:bg-[#5C8DFF] text-white font-semibold disabled:opacity-60"
                >
                  {busyPaths.has(WORKSPACE_ROOT) ? "Zipping…" : "⤓ Download .zip"}
                </button>
                <button
                  onClick={() => setZipMenu((m) => !m)}
                  aria-label="More download options"
                  className="text-[11px] px-2 py-[7px] rounded-r-lg bg-primary/85 hover:bg-[#5C8DFF] text-white border-l border-white/20"
                >
                  ▾
                </button>
                {zipMenu && (
                  <div
                    className="absolute right-0 top-full mt-1.5 w-[250px] z-20 rounded-lg border border-white/[0.14] bg-panel2 shadow-[0_18px_44px_rgba(0,0,0,.6)] p-1 anim-pop"
                    onMouseLeave={() => setZipMenu(false)}
                  >
                    <MenuItem
                      title="Whole workspace"
                      sub="Code only — skips node_modules, .git, .venv"
                      onClick={() => {
                        setZipMenu(false);
                        download({ path: WORKSPACE_ROOT, name: "workspace", type: "dir" });
                      }}
                    />
                    <MenuItem
                      title="Whole workspace + dependencies"
                      sub="Everything, including installed packages. Can be large."
                      onClick={() => {
                        setZipMenu(false);
                        download({ path: WORKSPACE_ROOT, name: "workspace", type: "dir" }, true);
                      }}
                    />
                    {targetDir() !== WORKSPACE_ROOT && (
                      <MenuItem
                        title={`Just ${agentNames[basename(targetDir())] ?? basename(targetDir())}`}
                        sub="The selected folder, as a .zip"
                        onClick={() => {
                          setZipMenu(false);
                          download({ path: targetDir(), name: basename(targetDir()), type: "dir" });
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="w-[30px] h-[30px] rounded-[7px] border border-white/[0.14] text-white/[0.55] hover:text-text hover:border-white/30 text-sm"
          >
            ×
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`flex-none px-4 py-1.5 text-[11px] border-b anim-fadein ${
            banner.kind === "error" ? "text-red-300 bg-red-500/[0.07] border-red-400/20" : "text-green bg-green/[0.06] border-green/20"
          }`}
        >
          {banner.text}
        </div>
      )}

      {!ready ? (
        <NotReady env={env} starting={starting} onStart={start} />
      ) : (
        <div className="flex-1 min-h-0 flex">
          {/* explorer */}
          <aside
            className={`flex-none w-[268px] border-r border-white/[0.08] flex flex-col min-h-0 bg-black/40 ${
              dragOver ? "outline outline-2 -outline-offset-2 outline-green/60 bg-green/[0.04]" : ""
            }`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              setDragOver(false);
              upload(e.dataTransfer.files);
            }}
          >
            <div className="flex-none flex items-center gap-1 pl-3.5 pr-2 h-[34px] border-b border-white/[0.07]">
              <span className="text-[9.5px] tracking-[0.11em] uppercase text-white/35">Explorer</span>
              <div className="ml-auto flex items-center gap-0.5">
                <HeaderIcon label="Upload files to the selected folder" onClick={() => fileInput.current?.click()}>
                  ⇪
                </HeaderIcon>
                <HeaderIcon label={showHidden ? "Hide dotfiles" : "Show dotfiles"} active={showHidden} onClick={() => setShowHidden((s) => !s)}>
                  .*
                </HeaderIcon>
                <HeaderIcon label="Refresh" onClick={() => refreshAll(true)}>
                  ⟳
                </HeaderIcon>
                <HeaderIcon
                  label="Collapse all"
                  onClick={() => {
                    setExpanded(new Set());
                    setSelected(null);
                  }}
                >
                  ⊟
                </HeaderIcon>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="flex-none px-2.5 py-2">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter files…"
                aria-label="Filter files"
                className="w-full bg-white/[0.03] border border-white/[0.1] rounded-md px-2.5 py-1.5 text-[11px] outline-none focus:border-accent/45"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden" role="tree">
              <FileTree
                root={WORKSPACE_ROOT}
                dirs={dirs}
                expanded={expanded}
                selected={selected}
                changed={changed}
                showHidden={showHidden}
                filter={filter}
                agentNames={agentNames}
                busyPaths={busyPaths}
                onToggle={toggleDir}
                onOpen={openFile}
                onDownload={(e) => download(e)}
                onPreview={(e) => serve(e.path)}
              />
            </div>
            {dragOver && (
              <div className="flex-none px-3 py-2 text-[10.5px] text-green border-t border-green/20">
                Drop to upload into {agentNames[basename(targetDir())] ?? basename(targetDir())}
              </div>
            )}
          </aside>

          {/* main */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="flex-1 min-h-0 flex">
              {view !== "preview" && (
                <section className={`min-w-0 flex flex-col min-h-0 ${view === "split" ? "w-1/2 border-r border-white/[0.08]" : "flex-1"}`}>
                  {tabs.length > 0 && (
                    <div className="flex-none flex items-stretch h-[34px] border-b border-white/[0.07] overflow-x-auto bg-black/30">
                      {tabs.map((t) => {
                        const on = t.path === active;
                        const dirty = t.draft !== null && t.draft !== t.content;
                        return (
                          <div
                            key={t.path}
                            onClick={() => {
                              setActive(t.path);
                              setSelected(t.path);
                            }}
                            onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
                            title={t.path}
                            className={`group flex-none flex items-center gap-2 pl-3 pr-1.5 text-[11.5px] cursor-pointer border-r border-white/[0.06] ${
                              on ? "bg-modal text-text shadow-[inset_0_2px_0_#5C8DFF]" : "text-white/50 hover:text-white/80"
                            }`}
                          >
                            <span className="max-w-[160px] truncate">{t.name}</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                closeTab(t.path);
                              }}
                              aria-label={`Close ${t.name}`}
                              className="w-4 h-4 grid place-items-center rounded text-[11px] text-white/40 hover:text-text hover:bg-white/10"
                            >
                              {dirty ? <span className="w-[6px] h-[6px] rounded-full bg-amber group-hover:hidden" /> : null}
                              <span className={dirty ? "hidden group-hover:inline" : ""}>×</span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {activeTab ? (
                    <CodeView
                      file={activeTab}
                      agentNames={agentNames}
                      downloading={busyPaths.has(activeTab.path)}
                      onEdit={() => setTabs((ts) => ts.map((t) => (t.path === activeTab.path ? { ...t, draft: t.content } : t)))}
                      onDraftChange={(d) => setTabs((ts) => ts.map((t) => (t.path === activeTab.path ? { ...t, draft: d } : t)))}
                      onCancelEdit={() => setTabs((ts) => ts.map((t) => (t.path === activeTab.path ? { ...t, draft: null } : t)))}
                      onSave={() => save(activeTab.path)}
                      onDownload={() => download({ path: activeTab.path, name: activeTab.name, type: "file" })}
                      onPreview={() => serve(activeTab.path)}
                    />
                  ) : (
                    <EmptyEditor
                      hasFiles={(dirs[WORKSPACE_ROOT]?.entries?.length ?? 0) > 0}
                      loading={!dirs[WORKSPACE_ROOT]?.entries}
                      onUpload={() => fileInput.current?.click()}
                    />
                  )}
                </section>
              )}
              {view !== "code" && (
                <PreviewPane
                  ports={allPorts}
                  portsLoaded={portsLoaded}
                  activePort={activePort}
                  path={previewPath}
                  reloadKey={reloadKey}
                  device={device}
                  autoReload={autoReload}
                  serveLabel={serveLabel}
                  serving={serving}
                  compact={view === "split"}
                  onSelectPort={(p) => {
                    setActivePort(p);
                    setPreviewPath("/");
                  }}
                  onNavigate={(p) => {
                    setPreviewPath(p);
                    setReloadKey((k) => k + 1);
                  }}
                  onReload={() => setReloadKey((k) => k + 1)}
                  onDevice={setDevice}
                  onAutoReload={setAutoReload}
                  onServe={() => serve(serveTarget)}
                  onOpenPort={openPort}
                />
              )}
            </div>

            {terminalOpened && (
              <div className={`flex-none h-[240px] border-t border-white/[0.09] flex-col ${terminalVisible ? "flex" : "hidden"}`}>
                <div className="flex-none flex items-center gap-2 px-3 h-[28px] border-b border-white/[0.06] text-[10px] text-white/40">
                  <span className="tracking-[0.11em] uppercase">Terminal</span>
                  <span className="font-mono text-white/25 truncate">
                    {initialPath ? `~/workspace/${basename(initialPath).slice(0, 8)}` : "~/workspace"}
                  </span>
                  <button onClick={() => setTerminalVisible(false)} className="ml-auto hover:text-text" aria-label="Hide terminal">
                    ⌄
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <TerminalPane projectId={projectId} nodeId={env.id} cwdHint={initialPath} visible={terminalVisible} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* status bar */}
      <div className="flex-none flex items-center gap-4 px-4 h-[26px] border-t border-white/[0.08] text-[10.5px] text-white/35 bg-black/40">
        {ready ? (
          <>
            <button onClick={() => setLive((l) => !l)} className="flex items-center gap-1.5 hover:text-text" title="Watch for changes agents make">
              <span className={`w-[5px] h-[5px] rounded-full ${live ? "bg-green anim-softpulse" : "bg-white/30"}`} />
              {live ? "Live" : "Paused"}
              {lastRefresh && <span className="text-white/25">· updated {timeAgo(new Date(lastRefresh).toISOString())}</span>}
            </button>
            <span>
              {allPorts.length} server{allPorts.length === 1 ? "" : "s"} running
            </span>
            {dirtyCount > 0 && <span className="text-amber/90">{dirtyCount} unsaved</span>}
          </>
        ) : (
          <span>Sandbox {env.status}</span>
        )}
        <span className="ml-auto truncate">
          {[
            env.sandbox_id ? `sandbox ${env.sandbox_id.slice(0, 12)}` : null,
            env.idle_timeout_s ? `pauses after ${Math.round(env.idle_timeout_s / 60)} min idle` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === "ready" ? "bg-green" : status === "error" ? "bg-red-400" : status === "provisioning" ? "bg-amber animate-pulse" : "bg-white/30";
  return (
    <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.05em] text-white/45 border border-white/[0.1] rounded-full px-2 py-[1px]">
      <span className={`w-[5px] h-[5px] rounded-full ${color}`} />
      {status}
    </span>
  );
}

function HeaderIcon({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`w-[22px] h-[22px] grid place-items-center rounded text-[11px] ${
        active ? "text-accent bg-accent/10" : "text-white/45 hover:text-text hover:bg-white/[0.06]"
      }`}
    >
      {children}
    </button>
  );
}

function MenuItem({ title, sub, onClick }: { title: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full text-left px-2.5 py-2 rounded-md hover:bg-white/[0.05]">
      <div className="text-[11.5px] text-text">{title}</div>
      <div className="text-[10px] text-white/40 mt-px leading-snug">{sub}</div>
    </button>
  );
}

function EmptyEditor({ hasFiles, loading, onUpload }: { hasFiles: boolean; loading: boolean; onUpload: () => void }) {
  return (
    <div className="flex-1 grid place-items-center p-8 bg-[#080C1C]">
      <div className="max-w-[320px] text-center">
        <div className="mx-auto w-11 h-11 rounded-xl border border-white/[0.14] grid place-items-center text-white/40">‹›</div>
        <div className="mt-3 text-[13px] text-white/80">
          {loading ? "Loading the workspace…" : hasFiles ? "Pick a file to read it" : "This workspace is empty"}
        </div>
        <div className="mt-1.5 text-[11.5px] text-white/40 leading-relaxed">
          {hasFiles
            ? "Each agent works in its own folder. Files they write appear here live, and HTML files can be previewed with ▶."
            : "Ask an agent to build something, or upload files to get started."}
        </div>
        {!loading && !hasFiles && (
          <button onClick={onUpload} className="mt-3 text-[11px] px-3 py-1.5 rounded-md border border-accent/40 text-accent bg-accent/5 hover:bg-accent/10">
            ⇪ Upload files
          </button>
        )}
      </div>
    </div>
  );
}

function NotReady({ env, starting, onStart }: { env: EnvironmentNode; starting: boolean; onStart: () => void }) {
  const provisioning = env.status === "provisioning" || starting;
  const copy: Record<string, string> = {
    pending: "This sandbox hasn't started yet — it spins up on an agent's first command. Start it now to browse and preview.",
    stopped: "This sandbox was stopped, which cleared its files. Starting it again begins with an empty workspace.",
    error: "The sandbox couldn't be reached. Starting reconnects to it if it's still alive, or makes a fresh one.",
    provisioning: "Starting the sandbox. This usually takes a few seconds.",
  };
  return (
    <div className="flex-1 grid place-items-center p-8">
      <div className="max-w-[380px] text-center">
        <div className="mx-auto w-12 h-12 rounded-xl border border-green/40 grid place-items-center text-green text-lg">{ENV_ICON}</div>
        <div className="mt-3 text-[14px] text-white/85">{provisioning ? "Starting…" : `Environment is ${env.status}`}</div>
        <div className="mt-1.5 text-[11.5px] text-white/45 leading-relaxed">{copy[provisioning ? "provisioning" : env.status] ?? ""}</div>
        {env.status_detail && !provisioning && (
          <div className="mt-2 text-[10.5px] text-white/30 font-mono break-words">{env.status_detail}</div>
        )}
        <button
          onClick={onStart}
          disabled={provisioning}
          className="mt-4 bg-green/90 hover:bg-green text-[#032b0a] rounded-lg px-5 py-2 text-xs font-semibold disabled:opacity-60"
        >
          {provisioning ? "Starting sandbox…" : env.status === "stopped" ? "Restart (empty)" : "Start environment"}
        </button>
      </div>
    </div>
  );
}
