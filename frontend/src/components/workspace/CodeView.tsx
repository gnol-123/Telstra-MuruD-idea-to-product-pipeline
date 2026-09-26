"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { highlight } from "@/lib/highlight";
import { formatBytes, isHtml, languageFor, relToWorkspace, timeAgo } from "@/lib/files";

export interface OpenFile {
  path: string;
  name: string;
  kind: "text" | "image" | "binary";
  loading: boolean;
  error: string | null;
  content: string;
  truncated: boolean;
  // Object URL for images; revoked when the tab closes.
  imageUrl: string | null;
  size: number;
  modified: string | null;
  // Editing state. draft !== null means the editor is open.
  draft: string | null;
  saving: boolean;
  // Bumped when the file is reloaded because an agent changed it, so the
  // view can say so.
  reloadedAt: number | null;
}

export default function CodeView({
  file,
  agentNames,
  onEdit,
  onDraftChange,
  onSave,
  onCancelEdit,
  onDownload,
  onPreview,
  downloading,
}: {
  file: OpenFile;
  agentNames: Record<string, string>;
  // Omit for a read-only view.
  onEdit?: () => void;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onDownload: () => void;
  onPreview: () => void;
  downloading: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const language = languageFor(file.name);
  const html = useMemo(
    () => (file.kind === "text" ? highlight(file.content, language) : ""),
    [file.kind, file.content, language]
  );
  const lineCount = useMemo(() => (file.content ? file.content.split("\n").length : 1), [file.content]);
  const editing = file.draft !== null;
  const dirty = editing && file.draft !== file.content;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  // Breadcrumb from the workspace root, with agent folders by name.
  const crumbs = relToWorkspace(file.path)
    .split("/")
    .filter(Boolean)
    .map((seg) => agentNames[seg] ?? seg);

  async function copy() {
    try {
      await navigator.clipboard.writeText(file.draft ?? file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions) — not worth an error.
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-none flex items-center gap-2 px-3.5 h-[34px] border-b border-white/[0.07] text-[11px]">
        <div className="min-w-0 flex items-center gap-1 text-white/40 truncate">
          <span className="text-white/30">workspace</span>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              <span className="text-white/20">›</span>
              <span className={i === crumbs.length - 1 ? "text-text truncate" : "truncate"}>{c}</span>
            </span>
          ))}
        </div>
        <span className="flex-none text-[10px] text-white/30 whitespace-nowrap">
          {formatBytes(file.size)}
          {file.modified ? ` · ${timeAgo(file.modified)}` : ""}
          {file.kind === "text" && language !== "plaintext" ? ` · ${language === "xml" ? "html" : language}` : ""}
        </span>
        {file.truncated && (
          <span className="flex-none text-[10px] text-amber border border-amber/40 rounded px-1.5 py-px" title="Only the start of this file is shown. Download it for the whole thing.">
            truncated
          </span>
        )}
        {file.reloadedAt && Date.now() - file.reloadedAt < 4000 && (
          <span className="flex-none text-[10px] text-green anim-fadein">● updated by agent</span>
        )}

        <div className="ml-auto flex-none flex items-center gap-1">
          {editing ? (
            <>
              <span className="text-[10px] text-white/35 mr-1">{dirty ? "unsaved" : "no changes"}</span>
              <ToolbarBtn onClick={onCancelEdit}>Cancel</ToolbarBtn>
              <ToolbarBtn primary disabled={!dirty || file.saving} onClick={onSave} title="Save (Ctrl/⌘ S)">
                {file.saving ? "Saving…" : "Save"}
              </ToolbarBtn>
            </>
          ) : (
            <>
              {isHtml(file.name) && (
                <ToolbarBtn onClick={onPreview} title="Serve this file and show it in the preview">
                  ▶ Preview
                </ToolbarBtn>
              )}
              {onEdit && file.kind === "text" && !file.truncated && !file.loading && !file.error && (
                <ToolbarBtn onClick={onEdit} title="Make a quick edit">
                  ✎ Edit
                </ToolbarBtn>
              )}
              {file.kind === "text" && (
                <ToolbarBtn onClick={copy}>{copied ? "Copied" : "Copy"}</ToolbarBtn>
              )}
              <ToolbarBtn onClick={onDownload} disabled={downloading} title="Download this file">
                {downloading ? "…" : "⤓ Download"}
              </ToolbarBtn>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto bg-[#05080a]">
        {file.loading && !file.content && !file.imageUrl ? (
          <div className="p-5 space-y-2">
            {[70, 52, 84, 40, 66].map((w, i) => (
              <div key={i} className="h-3 rounded bg-white/[0.05] anim-softpulse" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : file.error ? (
          <Notice title="Couldn't open this file" body={file.error} />
        ) : file.kind === "image" ? (
          <div className="min-h-full grid place-items-center p-6 checker">
            {file.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={file.imageUrl} alt={file.name} className="max-w-full max-h-[70vh] object-contain shadow-[0_10px_40px_rgba(0,0,0,.6)]" />
            )}
          </div>
        ) : file.kind === "binary" ? (
          <Notice
            title="Binary file"
            body={`${file.name} (${formatBytes(file.size)}) isn't text, so there's nothing to show here. Download it to open it locally.`}
            action={
              <button
                onClick={onDownload}
                className="mt-3 text-[11px] px-3 py-1.5 rounded-md border border-accent/40 text-accent bg-accent/5 hover:bg-accent/10"
              >
                ⤓ Download {file.name}
              </button>
            }
          />
        ) : editing ? (
          <textarea
            ref={editorRef}
            value={file.draft ?? ""}
            onChange={(e) => onDraftChange(e.target.value)}
            spellCheck={false}
            className="code-view w-full h-full min-h-full resize-none bg-transparent text-text outline-none p-3.5 pl-4"
          />
        ) : (
          <div className="flex min-w-max">
            <div
              aria-hidden
              className="code-view flex-none select-none text-right text-white/20 pl-3 pr-3 py-3 border-r border-white/[0.05] sticky left-0 bg-[#05080a]"
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre className="code-view flex-1 py-3 pl-4 pr-6 text-text select-text">
              <code dangerouslySetInnerHTML={{ __html: html || " " }} />
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="h-full grid place-items-center p-8">
      <div className="max-w-sm text-center">
        <div className="text-[13px] text-white/80">{title}</div>
        <div className="mt-1.5 text-[11.5px] text-white/40 leading-relaxed">{body}</div>
        {action}
      </div>
    </div>
  );
}

export function ToolbarBtn({
  children,
  onClick,
  disabled,
  primary,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`whitespace-nowrap text-[10.5px] px-2 py-[3px] rounded-[5px] border transition-colors disabled:opacity-40 ${
        primary
          ? "bg-accent border-accent text-[#00191d] font-semibold hover:bg-[#5eeaf6]"
          : active
          ? "border-accent/45 text-accent bg-accent/10"
          : "border-white/[0.12] text-white/60 hover:text-text hover:border-white/30"
      }`}
    >
      {children}
    </button>
  );
}
