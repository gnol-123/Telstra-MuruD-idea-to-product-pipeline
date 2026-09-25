"use client";

import { EnvironmentFileEntry } from "@/lib/types";
import { fileGlyph, formatBytes, isHtml, isNoise, timeAgo } from "@/lib/files";

export interface DirState {
  entries: EnvironmentFileEntry[] | null;
  loading: boolean;
  error: string | null;
}

// Directories first, noise (node_modules, .git...) last, then by name.
export function sortEntries(entries: EnvironmentFileEntry[]): EnvironmentFileEntry[] {
  return [...entries].sort((a, b) => {
    const ad = a.type === "dir" ? 0 : 1;
    const bd = b.type === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const an = isNoise(a.name) ? 1 : 0;
    const bn = isNoise(b.name) ? 1 : 0;
    if (an !== bn) return an - bn;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export default function FileTree({
  root,
  dirs,
  expanded,
  selected,
  changed,
  showHidden,
  filter,
  agentNames,
  busyPaths,
  onToggle,
  onOpen,
  onDownload,
  onPreview,
}: {
  root: string;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  selected: string | null;
  // Paths an agent changed since the last refresh — they flash once.
  changed: Set<string>;
  showHidden: boolean;
  filter: string;
  // Agent working folders are named by node id; show the agent's name.
  agentNames: Record<string, string>;
  // Downloads or serves in flight, keyed by path — row shows a spinner.
  busyPaths: Set<string>;
  onToggle: (dir: string) => void;
  onOpen: (entry: EnvironmentFileEntry) => void;
  onDownload: (entry: EnvironmentFileEntry) => void;
  onPreview: (entry: EnvironmentFileEntry) => void;
}) {
  const visible = (e: EnvironmentFileEntry) => showHidden || !e.name.startsWith(".");

  // Filtering searches everything loaded so far, flattened, rather than
  // walking the sandbox: the tree only knows the folders someone opened.
  if (filter.trim()) {
    const q = filter.trim().toLowerCase();
    const hits: EnvironmentFileEntry[] = [];
    for (const d of Object.values(dirs)) {
      for (const e of d.entries ?? []) if (visible(e) && e.name.toLowerCase().includes(q)) hits.push(e);
    }
    return (
      <div className="py-1">
        {hits.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-white/35 leading-relaxed">
            No match in the folders loaded so far. Open a folder to search inside it.
          </div>
        ) : (
          sortEntries(hits).map((e) => (
            <Row
              key={e.path}
              entry={e}
              depth={0}
              label={agentNames[e.name] ?? e.name}
              sub={e.path.slice(root.length + 1)}
              open={expanded.has(e.path)}
              selected={selected === e.path}
              changed={changed.has(e.path)}
              busy={busyPaths.has(e.path)}
              onToggle={onToggle}
              onOpen={onOpen}
              onDownload={onDownload}
              onPreview={onPreview}
            />
          ))
        )}
      </div>
    );
  }

  function renderDir(path: string, depth: number): React.ReactNode {
    const state = dirs[path];
    if (!state || (state.loading && !state.entries)) {
      return <Hint depth={depth}>Loading…</Hint>;
    }
    if (state.error && !state.entries) {
      return <Hint depth={depth} error>{state.error}</Hint>;
    }
    const entries = sortEntries((state.entries ?? []).filter(visible));
    if (entries.length === 0) return <Hint depth={depth}>Empty folder</Hint>;
    return entries.map((e) => {
      const isDir = e.type === "dir";
      const agent = isDir ? agentNames[e.name] : undefined;
      return (
        <div key={e.path}>
          <Row
            entry={e}
            depth={depth}
            label={agent ?? e.name}
            sub={agent ? `agent · ${e.name.slice(0, 8)}` : undefined}
            open={expanded.has(e.path)}
            selected={selected === e.path}
            changed={changed.has(e.path)}
            busy={busyPaths.has(e.path)}
            onToggle={onToggle}
            onOpen={onOpen}
            onDownload={onDownload}
            onPreview={onPreview}
          />
          {isDir && expanded.has(e.path) && renderDir(e.path, depth + 1)}
        </div>
      );
    });
  }

  return <div className="py-1">{renderDir(root, 0)}</div>;
}

function Hint({ children, depth, error }: { children: React.ReactNode; depth: number; error?: boolean }) {
  return (
    <div
      style={{ paddingLeft: 14 + depth * 13 + 16 }}
      className={`pr-3 py-[3px] text-[10.5px] ${error ? "text-red-400/80" : "text-white/30"}`}
    >
      {children}
    </div>
  );
}

function Row({
  entry,
  depth,
  label,
  sub,
  open,
  selected,
  changed,
  busy,
  onToggle,
  onOpen,
  onDownload,
  onPreview,
}: {
  entry: EnvironmentFileEntry;
  depth: number;
  label: string;
  sub?: string;
  open: boolean;
  selected: boolean;
  changed: boolean;
  busy: boolean;
  onToggle: (dir: string) => void;
  onOpen: (entry: EnvironmentFileEntry) => void;
  onDownload: (entry: EnvironmentFileEntry) => void;
  onPreview: (entry: EnvironmentFileEntry) => void;
}) {
  const isDir = entry.type === "dir";
  const noise = isDir && isNoise(entry.name);
  const hidden = entry.name.startsWith(".");
  const previewable = isDir || isHtml(entry.name);
  const title = [
    entry.path,
    !isDir ? formatBytes(entry.size) : null,
    entry.modified ? `modified ${timeAgo(entry.modified)}` : null,
    entry.symlink_target ? `→ ${entry.symlink_target}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="treeitem"
      aria-expanded={isDir ? open : undefined}
      aria-selected={selected}
      title={title}
      onClick={() => (isDir ? onToggle(entry.path) : onOpen(entry))}
      style={{ paddingLeft: 10 + depth * 13 }}
      className={`group relative flex items-center gap-1.5 pr-2 h-[25px] cursor-pointer text-[12px] ${
        selected ? "bg-accent/[0.11] text-text" : "text-white/[0.72] hover:bg-white/[0.04] hover:text-text"
      } ${changed ? "anim-changed" : ""} ${noise || hidden ? "opacity-50" : ""}`}
    >
      {selected && <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" />}
      <span className="w-3 flex-none text-center text-[9px] text-white/40">{isDir ? (open ? "▾" : "▸") : ""}</span>
      <span
        className={`flex-none w-4 text-center text-[10px] ${
          isDir ? "text-accent/80" : isHtml(entry.name) ? "text-amber/90" : "text-white/40"
        }`}
      >
        {isDir ? (open ? "▣" : "▢") : fileGlyph(entry.name)}
      </span>
      <span className="truncate min-w-0">
        {label}
        {sub && <span className="ml-1.5 text-[10px] text-white/30">{sub}</span>}
        {entry.type === "symlink" && <span className="ml-1 text-[10px] text-white/30">↗</span>}
      </span>
      {changed && <span className="flex-none w-[5px] h-[5px] rounded-full bg-green" title="Changed just now" />}

      <span className="ml-auto flex-none flex items-center gap-0.5">
        {!isDir && (
          <span className="text-[10px] text-white/25 tabular-nums group-hover:hidden">{formatBytes(entry.size)}</span>
        )}
        {busy ? (
          <span className="w-[11px] h-[11px] rounded-full border border-white/25 border-t-accent animate-spin" />
        ) : (
          <span className="hidden group-hover:flex items-center gap-0.5">
            {previewable && (
              <IconBtn
                label={isDir ? "Serve this folder in the preview" : "Open in the preview"}
                onClick={() => onPreview(entry)}
              >
                ▶
              </IconBtn>
            )}
            <IconBtn
              label={isDir ? "Download folder as .zip" : "Download file"}
              onClick={() => onDownload(entry)}
            >
              ⤓
            </IconBtn>
          </span>
        )}
      </span>
    </div>
  );
}

function IconBtn({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="w-[20px] h-[20px] grid place-items-center rounded text-[10.5px] text-white/50 hover:text-accent hover:bg-accent/10"
    >
      {children}
    </button>
  );
}
