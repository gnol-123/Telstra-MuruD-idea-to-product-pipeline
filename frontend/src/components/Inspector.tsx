"use client";

import { useEffect, useRef, useState } from "react";
import {
  ProjectNode,
  AgentNode,
  Edge,
  ToolType,
  ToolCall,
  ToolPolicy,
  EnvironmentFileEntry,
  isAgentNode,
  isEnvironmentNode,
  isToolNode,
} from "@/lib/types";
import {
  verifyNode,
  authorizeNode,
  listToolCalls,
  updateEnvironment,
  startEnvironment,
  stopEnvironment,
  verifyEnvironment,
  listEnvironmentFiles,
  readEnvironmentFile,
  getEnvironmentPreview,
  environmentTerminalUrl,
  ApiError,
} from "@/lib/api";
import { AGENT_ICONS, ENV_ICON, TOOL_ICONS, agentRole } from "./NodeCard";

export default function Inspector({
  projectId,
  node,
  nodes,
  edges,
  toolTypes,
  chatBusy,
  refreshingEdgeId,
  onOpenChat,
  onUpdateAgentPolicy,
  onRefreshEdge,
  onDeleteEdge,
  onUnequipTool,
  onNodeUpdated,
}: {
  projectId: string;
  node: ProjectNode | null;
  nodes: ProjectNode[];
  edges: Edge[];
  toolTypes: ToolType[];
  // A chat turn is in flight for the selected agent (see ChatWindow).
  chatBusy: boolean;
  refreshingEdgeId: string | null;
  onOpenChat: (nodeId: string) => void;
  onUpdateAgentPolicy: (nodeId: string, policy: ToolPolicy) => void;
  onRefreshEdge: (edge: Edge) => Promise<void> | void;
  onDeleteEdge: (edge: Edge) => void;
  // Tool edges specifically: removes the edge AND nudges the now-bare tool
  // node back into view near its former agent (see MeshCanvas).
  onUnequipTool: (edge: Edge) => void;
  onNodeUpdated: (node: ProjectNode) => void;
}) {
  const title = !node
    ? "Inspector"
    : isAgentNode(node)
    ? "Agent inspector"
    : isEnvironmentNode(node)
    ? "Environment inspector"
    : "Tool inspector";

  return (
    <aside className="flex-none w-[300px] border-l border-white/[0.09] flex flex-col min-h-0 bg-black">
      <div className="flex-none px-[18px] pt-4 pb-3 border-b border-white/[0.09]">
        <div className="text-[12.5px] font-semibold">{title}</div>
        <div className="mt-1 text-[10.5px] text-white/[0.36] truncate">{node ? `Editing ${node.name}` : "Nothing selected"}</div>
      </div>

      {!node ? (
        <div className="px-[18px] py-4 text-xs text-white/[0.35] leading-relaxed">
          Select a card to inspect its tools, inherited context and downstream consumers. Double-click an agent to chat
          with it.
        </div>
      ) : isAgentNode(node) ? (
        <AgentInspector
          key={node.id}
          node={node}
          nodes={nodes}
          edges={edges}
          toolTypes={toolTypes}
          chatBusy={chatBusy}
          refreshingEdgeId={refreshingEdgeId}
          onOpenChat={() => onOpenChat(node.id)}
          onUpdateAgentPolicy={onUpdateAgentPolicy}
          onRefreshEdge={onRefreshEdge}
          onDeleteEdge={onDeleteEdge}
          onUnequipTool={onUnequipTool}
        />
      ) : isEnvironmentNode(node) ? (
        <EnvironmentInspector
          key={node.id}
          projectId={projectId}
          node={node}
          nodes={nodes}
          edges={edges}
          onDeleteEdge={onDeleteEdge}
          onNodeUpdated={onNodeUpdated}
        />
      ) : (
        <ToolInspector
          key={node.id}
          projectId={projectId}
          node={node}
          nodes={nodes}
          edges={edges}
          toolTypes={toolTypes}
          onDeleteEdge={onDeleteEdge}
          onNodeUpdated={onNodeUpdated}
        />
      )}
    </aside>
  );
}

function nodeName(nodes: ProjectNode[], id: string) {
  return nodes.find((n) => n.id === id)?.name ?? "Unknown";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[9.5px] tracking-[0.11em] uppercase text-white/30 mb-2">{children}</div>;
}

function Empty({ children, dashed }: { children: React.ReactNode; dashed?: boolean }) {
  return (
    <div
      className={`text-[11px] text-white/[0.35] leading-[1.5] ${
        dashed ? "border border-dashed border-white/[0.15] rounded-[7px] px-[11px] py-3" : ""
      }`}
    >
      {children}
    </div>
  );
}

// -------------------- Agent inspector --------------------
// Compact summary, matching the UX mockup. The conversation itself lives
// in the ChatWindow modal, opened from the button at the bottom (or by
// double-clicking the card / its "Open chat" button).

function AgentInspector({
  node,
  nodes,
  edges,
  toolTypes,
  chatBusy,
  refreshingEdgeId,
  onOpenChat,
  onUpdateAgentPolicy,
  onRefreshEdge,
  onDeleteEdge,
  onUnequipTool,
}: {
  node: AgentNode;
  nodes: ProjectNode[];
  edges: Edge[];
  toolTypes: ToolType[];
  chatBusy: boolean;
  refreshingEdgeId: string | null;
  onOpenChat: () => void;
  onUpdateAgentPolicy: (nodeId: string, policy: ToolPolicy) => void;
  onRefreshEdge: (edge: Edge) => Promise<void> | void;
  onDeleteEdge: (edge: Edge) => void;
  onUnequipTool: (edge: Edge) => void;
}) {
  const inboundTool = edges.filter((e) => e.kind === "tool" && e.target_node_id === node.id);
  const inboundEnv = edges.filter((e) => e.kind === "environment" && e.target_node_id === node.id);
  const inboundContext = edges.filter((e) => e.kind === "context" && e.target_node_id === node.id);
  const outbound = edges.filter((e) => e.kind === "context" && e.source_node_id === node.id);
  const stale = inboundContext.filter((e) => e.is_stale);
  const clearing = stale.some((e) => e.id === refreshingEdgeId);
  const icon = AGENT_ICONS[node.agent_slug] ?? "◆";
  const status = chatBusy ? "running" : node.status ?? "ready";

  return (
    <div className="flex-1 overflow-auto px-[18px] py-4 flex flex-col gap-4 min-h-0">
      <div>
        <SectionLabel>Identity</SectionLabel>
        <div className="flex gap-2.5 items-start">
          <div className="flex-none w-8 h-8 rounded-lg border border-accent/50 grid place-items-center text-accent text-sm">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold truncate">{node.name}</div>
            <div className="text-[11px] text-white/[0.45] mt-[3px] leading-[1.45]">{agentRole(node.agent_slug)}</div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-white/[0.42] uppercase tracking-[0.04em]">
              <span
                className={`w-[5px] h-[5px] rounded-full ${
                  status === "running" ? "bg-green anim-softpulse" : status === "error" ? "bg-red-400" : "bg-white/30"
                }`}
              />
              {status}
              {node.model && <span className="normal-case tracking-normal text-white/30">· {node.model}</span>}
            </div>
          </div>
        </div>
      </div>

      <div>
        <SectionLabel>Tool policy</SectionLabel>
        <select
          value={node.tool_policy}
          onChange={(e) => onUpdateAgentPolicy(node.id, e.target.value as ToolPolicy)}
          className="w-full bg-white/[0.03] border border-white/[0.12] rounded-[7px] px-2.5 py-2 text-[11.5px] outline-none focus:border-accent/50"
        >
          <option value="ask">Ask before every tool call</option>
          <option value="auto">Run tools automatically</option>
        </select>
      </div>

      <div>
        <SectionLabel>Tools ({inboundTool.length})</SectionLabel>
        {inboundTool.length === 0 ? (
          <Empty dashed>Open the Tools tab and drag a tool onto this card.</Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {inboundTool.map((e) => {
              const t = nodes.find((n) => n.id === e.source_node_id);
              const tool = t && isToolNode(t) ? t : null;
              const desc =
                tool?.status === "error"
                  ? tool.status_detail ?? "error"
                  : toolTypes.find((tt) => tt.slug === tool?.tool_slug)?.description ?? tool?.tool_slug ?? "";
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-[9px] px-2.5 py-2 rounded-[7px] bg-accent/[0.05] border border-accent/20"
                >
                  <span className="text-accent text-[11px]">{tool ? TOOL_ICONS[tool.tool_slug] ?? "◆" : "◆"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] text-text truncate">{t?.name ?? "Unknown tool"}</div>
                    <div
                      className={`text-[10px] mt-px truncate ${tool?.status === "error" ? "text-red-400/80" : "text-white/[0.35]"}`}
                      title={desc}
                    >
                      {desc}
                    </div>
                  </div>
                  <button
                    onClick={() => onUnequipTool(e)}
                    className="text-white/30 hover:text-white/70 text-xs"
                    title="Unequip"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <SectionLabel>Environments ({inboundEnv.length})</SectionLabel>
        {inboundEnv.length === 0 ? (
          <Empty>No sandbox linked — uses the project&apos;s shared scratch environment only.</Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {inboundEnv.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-[9px] px-2.5 py-2 rounded-[7px] bg-green/[0.05] border border-green/20"
              >
                <span className="text-green text-[11px]">{ENV_ICON}</span>
                <span className="flex-1 truncate text-[11.5px]">{nodeName(nodes, e.source_node_id)}</span>
                <button onClick={() => onDeleteEdge(e)} className="text-white/30 hover:text-white/70 text-xs" title="Unlink">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionLabel>Inherited context</SectionLabel>
        <div className="flex flex-col gap-1.5">
          {stale.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-2.5 py-[9px] rounded-[7px] mb-0.5 border border-amber/[0.35] bg-amber/[0.06]">
              <span className="text-amber text-[11px]">⟳</span>
              <span className="text-[10.5px] text-white/60 leading-[1.4] flex-1 min-w-[110px]">
                Upstream output changed — this agent holds stale context
              </span>
              <button
                disabled={clearing}
                onClick={() => stale.forEach((e) => onRefreshEdge(e))}
                className="whitespace-nowrap bg-amber text-[#2b1a00] rounded-[5px] px-2.5 py-[5px] text-[10px] font-semibold disabled:opacity-60"
              >
                {clearing ? "Clearing…" : "⟳ Clear stale context"}
              </button>
            </div>
          )}
          {inboundContext.length === 0 ? (
            <Empty>Runs on its own context only.</Empty>
          ) : (
            inboundContext.map((e) => (
              <div key={e.id} className="group flex items-center gap-2 text-[11.5px] text-white/[0.72]">
                <span className={`text-[10px] ${e.is_stale ? "text-amber" : "text-accent"}`}>◗</span>
                <span className="truncate">{nodeName(nodes, e.source_node_id)}</span>
                <span className="ml-auto text-[10px] text-white/30">
                  {e.summary_updated_at === null ? "no summary" : e.is_stale ? "stale" : "synced"}
                </span>
                <button
                  onClick={() => onDeleteEdge(e)}
                  className="text-white/0 group-hover:text-white/40 hover:!text-white/70 text-xs"
                  title="Cut this link"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div>
        <SectionLabel>Shares with</SectionLabel>
        {outbound.length === 0 ? (
          <Empty>No downstream consumers.</Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {outbound.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-[11.5px] text-white/[0.72]">
                <span className="text-accent text-[10px]">▸</span>
                {nodeName(nodes, e.target_node_id)}
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onOpenChat}
        className="mt-0.5 bg-accent hover:bg-[#5eeaf6] text-[#00191d] rounded-lg px-3.5 py-2.5 text-xs font-semibold transition-colors"
      >
        {chatBusy ? "● Reply in progress — open chat" : `Open chat with ${node.name}`}
      </button>
    </div>
  );
}

// -------------------- Tool inspector --------------------

function ToolInspector({
  projectId,
  node,
  nodes,
  edges,
  toolTypes,
  onDeleteEdge,
  onNodeUpdated,
}: {
  projectId: string;
  node: Extract<ProjectNode, { kind: "tool" }>;
  nodes: ProjectNode[];
  edges: Edge[];
  toolTypes: ToolType[];
  onDeleteEdge: (edge: Edge) => void;
  onNodeUpdated: (node: ProjectNode) => void;
}) {
  const toolType = toolTypes.find((t) => t.slug === node.tool_slug);
  const attachedTo = edges.filter((e) => e.kind === "tool" && e.source_node_id === node.id);
  const [verifying, setVerifying] = useState(false);
  const [calls, setCalls] = useState<ToolCall[] | null>(null);
  const [callsError, setCallsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listToolCalls(projectId, node.id, 20)
      .then((c) => !cancelled && setCalls(c))
      .catch((e: ApiError) => !cancelled && setCallsError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, node.id]);

  async function handleVerify() {
    setVerifying(true);
    try {
      const updated = await verifyNode(projectId, node.id);
      onNodeUpdated(updated);
    } catch (e) {
      // verify never raises per API.md, but the request itself might fail
    } finally {
      setVerifying(false);
    }
  }

  async function handleConnect() {
    try {
      const { url } = await authorizeNode(projectId, node.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      // surfaced via node status after the user completes/abandons consent
    }
  }

  const secretsSet = node.secrets_set ?? [];
  const configEntries = Object.entries(node.config ?? {}).filter(
    ([k]) => !secretsSet.includes(k)
  );

  return (
    <>
      <div className="flex-1 overflow-y-auto px-[18px] py-4 space-y-4">
        <div>
          <SectionLabel>Identity</SectionLabel>
          <div className="flex gap-2.5 items-start">
            <div className="flex-none w-8 h-8 rounded-lg border border-accent/50 grid place-items-center text-accent text-sm">
              {TOOL_ICONS[node.tool_slug] ?? "◆"}
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold truncate">{node.name}</div>
              <div className="text-[11px] text-white/[0.45] mt-[3px]">{toolType?.name ?? node.tool_slug}</div>
            </div>
          </div>
        </div>

        {attachedTo.length > 0 && (
          <div className="text-[11px] text-accent bg-accent/5 border border-accent/20 rounded-md px-2.5 py-1.5">
            Equipped on {attachedTo.map((e) => nodeName(nodes, e.target_node_id)).join(", ")} — shown as a
            chip on that card.
          </div>
        )}

        <div>
          <SectionLabel>Status</SectionLabel>
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                node.status === "ready" ? "bg-green" : node.status === "error" ? "bg-red-400" : "bg-white/30"
              }`}
            />
            <span className="text-xs uppercase tracking-wide">{node.status}</span>
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="ml-auto text-[10px] px-2 py-1 border border-border rounded-md text-muted hover:text-text disabled:opacity-50"
            >
              {verifying ? "Verifying…" : "Verify"}
            </button>
          </div>
          {node.status_detail && (
            <div className="mt-1.5 text-[11px] text-muted leading-relaxed">{node.status_detail}</div>
          )}
          {toolType?.auth_kind === "oauth2" && node.status !== "ready" && (
            <button
              onClick={handleConnect}
              className="mt-2 w-full bg-accent/15 text-accent border border-accent/40 rounded-md py-1.5 text-xs"
            >
              Connect account
            </button>
          )}
        </div>

        {toolType?.description && (
          <div className="text-[11px] text-muted leading-relaxed">{toolType.description}</div>
        )}

        <div>
          <SectionLabel>Config</SectionLabel>
          <div className="space-y-1">
            {configEntries.map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-[11px]">
                <span className="text-muted w-24 truncate">{k}</span>
                <span className="truncate">{String(v)}</span>
              </div>
            ))}
            {secretsSet.map((k) => (
              <div key={k} className="flex items-center gap-2 text-[11px]">
                <span className="text-muted w-24 truncate">{k}</span>
                <span className="text-white/50">•••• set</span>
              </div>
            ))}
            {configEntries.length === 0 && secretsSet.length === 0 && (
              <div className="text-[11px] text-muted">No configuration.</div>
            )}
          </div>
        </div>

        <div>
          <SectionLabel>Attached to ({attachedTo.length})</SectionLabel>
          {attachedTo.length === 0 ? (
            <div className="text-[11px] text-muted">
              Drop this tool onto an agent card, or drag its ◗ port onto one, to make it callable there.
            </div>
          ) : (
            <div className="space-y-1.5">
              {attachedTo.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 truncate">{nodeName(nodes, e.target_node_id)}</span>
                  <button onClick={() => onDeleteEdge(e)} className="text-white/30 hover:text-white/70">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionLabel>Recent calls</SectionLabel>
          {callsError && <div className="text-[11px] text-red-400">{callsError}</div>}
          {!callsError && calls === null && <div className="text-[11px] text-muted">Loading…</div>}
          {calls && calls.length === 0 && (
            <div className="text-[11px] text-muted">No calls logged yet.</div>
          )}
          {calls && calls.length > 0 && (
            <div className="space-y-1.5">
              {calls.map((c) => (
                <div key={c.id} className="text-[11px] border border-border rounded-md px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        c.status === "ok"
                          ? "text-green"
                          : c.status === "error"
                          ? "text-red-400"
                          : c.status === "denied"
                          ? "text-white/40"
                          : "text-amber"
                      }
                    >
                      ●
                    </span>
                    <span className="flex-1 truncate">{c.tool_name}</span>
                    <span className="text-muted text-[10px]">{c.status}</span>
                  </div>
                  {c.duration_ms != null && (
                    <div className="text-muted text-[10px] mt-0.5">{c.duration_ms}ms</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// -------------------- Environment inspector --------------------

function EnvironmentInspector({
  projectId,
  node,
  nodes,
  edges,
  onDeleteEdge,
  onNodeUpdated,
}: {
  projectId: string;
  node: Extract<ProjectNode, { kind: "environment" }>;
  nodes: ProjectNode[];
  edges: Edge[];
  onDeleteEdge: (edge: Edge) => void;
  onNodeUpdated: (node: ProjectNode) => void;
}) {
  const attachedTo = edges.filter((e) => e.kind === "environment" && e.source_node_id === node.id);
  const [busy, setBusy] = useState<"start" | "stop" | "verify" | null>(null);
  const [name, setName] = useState(node.name);
  const [savingName, setSavingName] = useState(false);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<EnvironmentFileEntry[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [fileView, setFileView] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [port, setPort] = useState("3000");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const ready = node.status === "ready";

  useEffect(() => {
    if (!ready) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    setFilesError(null);
    listEnvironmentFiles(projectId, node.id, path || undefined)
      .then((r) => !cancelled && setEntries(r.entries))
      .catch((e: ApiError) => !cancelled && setFilesError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, node.id, path, ready]);

  async function run(action: "start" | "stop" | "verify") {
    setBusy(action);
    try {
      const fn = action === "start" ? startEnvironment : action === "stop" ? stopEnvironment : verifyEnvironment;
      const updated = await fn(projectId, node.id);
      onNodeUpdated(updated);
    } catch (e) {
      // start/verify never raise per API.md; stop can 409 if provisioning —
      // either way there's nothing actionable to show beyond the status pill
    } finally {
      setBusy(null);
    }
  }

  async function openFile(entry: EnvironmentFileEntry) {
    if (entry.type === "dir") {
      setPath(entry.path);
      return;
    }
    try {
      const f = await readEnvironmentFile(projectId, node.id, entry.path);
      setFileView(f);
    } catch (e) {
      setFilesError(e instanceof ApiError ? e.message : "Could not read file");
    }
  }

  async function openPreview() {
    setPreviewError(null);
    setPreviewUrl(null);
    const p = parseInt(port, 10);
    if (!p || p < 1 || p > 65535) {
      setPreviewError("Enter a port between 1 and 65535.");
      return;
    }
    try {
      const r = await getEnvironmentPreview(projectId, node.id, p);
      setPreviewUrl(r.url);
    } catch (e) {
      setPreviewError(e instanceof ApiError ? e.message : "Could not get a preview URL");
    }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-[18px] py-4 space-y-4">
        <div className="flex gap-2.5 items-start">
          <div className="flex-none w-8 h-8 rounded-lg border border-green/50 grid place-items-center text-green text-sm">
            {ENV_ICON}
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold truncate">{node.name}</div>
            <div className="text-[11px] text-white/[0.45] mt-[3px]">
              {node.runtime} sandbox · {node.role === "scratch" ? "shared scratch space" : "user-provisioned"}
            </div>
          </div>
        </div>

        <div>
          <SectionLabel>Status</SectionLabel>
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                node.status === "ready"
                  ? "bg-green"
                  : node.status === "error"
                  ? "bg-red-400"
                  : node.status === "provisioning"
                  ? "bg-amber animate-pulse"
                  : "bg-white/30"
              }`}
            />
            <span className="text-xs uppercase tracking-wide">{node.status}</span>
            {node.sandbox_id && <span className="text-[10px] text-muted ml-1">{node.sandbox_id.slice(0, 10)}</span>}
          </div>
          {node.status_detail && (
            <div className="mt-1.5 text-[11px] text-muted leading-relaxed">{node.status_detail}</div>
          )}
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={() => run("start")}
              disabled={busy !== null}
              className="flex-1 text-[10px] px-2 py-1.5 border border-green/40 text-green bg-green/5 rounded-md disabled:opacity-50"
            >
              {busy === "start" ? "Starting…" : node.status === "stopped" ? "Restart" : "Start"}
            </button>
            <button
              onClick={() => run("stop")}
              disabled={busy !== null || node.status === "stopped"}
              className="flex-1 text-[10px] px-2 py-1.5 border border-border text-muted hover:text-text rounded-md disabled:opacity-50"
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </button>
            <button
              onClick={() => run("verify")}
              disabled={busy !== null}
              className="flex-1 text-[10px] px-2 py-1.5 border border-border text-muted hover:text-text rounded-md disabled:opacity-50"
            >
              {busy === "verify" ? "Checking…" : "Verify"}
            </button>
          </div>
          {node.status === "stopped" && (
            <div className="mt-1.5 text-[10px] text-muted leading-relaxed">
              Stopping destroyed its filesystem — starting again begins empty.
            </div>
          )}
        </div>

        <div>
          <SectionLabel>Name &amp; policy</SectionLabel>
          <div className="flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 min-w-0 bg-panel2 border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-accent/50"
            />
            <button
              onClick={async () => {
                if (!name.trim() || name === node.name) return;
                setSavingName(true);
                try {
                  const updated = await updateEnvironment(projectId, node.id, { name: name.trim() });
                  onNodeUpdated(updated);
                } catch {
                  // best-effort rename
                } finally {
                  setSavingName(false);
                }
              }}
              disabled={savingName || !name.trim() || name === node.name}
              className="text-[10px] px-2.5 border border-border rounded-md text-muted hover:text-text disabled:opacity-40"
            >
              {savingName ? "…" : "Rename"}
            </button>
          </div>
          <select
            value={node.tool_policy}
            onChange={async (e) => {
              const updated = await updateEnvironment(projectId, node.id, {
                tool_policy: e.target.value as ToolPolicy,
              }).catch(() => null);
              if (updated) onNodeUpdated(updated);
            }}
            className="mt-1.5 w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-accent/50"
          >
            <option value="ask">Ask before executing in this shell</option>
            <option value="auto">Run commands automatically</option>
          </select>
        </div>

        <div>
          <SectionLabel>Callable by ({attachedTo.length})</SectionLabel>
          {attachedTo.length === 0 ? (
            <div className="text-[11px] text-muted">
              Drag this environment's ◗ port onto an agent card to give it a shell to execute in.
            </div>
          ) : (
            <div className="space-y-1.5">
              {attachedTo.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 truncate">{nodeName(nodes, e.target_node_id)}</span>
                  <button onClick={() => onDeleteEdge(e)} className="text-white/30 hover:text-white/70">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionLabel>Preview a port</SectionLabel>
          <div className="flex gap-1.5">
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="3000"
              className="w-20 bg-panel2 border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-accent/50"
            />
            <button
              onClick={openPreview}
              disabled={!ready}
              className="flex-1 text-[10px] border border-accent/40 text-accent bg-accent/5 rounded-md disabled:opacity-40"
              title={ready ? undefined : "Environment must be ready first"}
            >
              Get preview URL
            </button>
          </div>
          {previewError && <div className="mt-1.5 text-[10px] text-red-400">{previewError}</div>}
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 block text-[10px] text-accent underline break-all"
            >
              {previewUrl}
            </a>
          )}
        </div>

        <div>
          <SectionLabel>Files</SectionLabel>
          {!ready ? (
            <div className="text-[11px] text-muted">Start the environment to browse its filesystem.</div>
          ) : (
            <>
              <div className="flex items-center gap-1.5 text-[10px] text-muted mb-1.5">
                <button onClick={() => setPath("")} className="hover:text-text">
                  workspace
                </button>
                {path && <span className="truncate">/ {path}</span>}
              </div>
              {filesError && <div className="text-[11px] text-red-400">{filesError}</div>}
              {entries === null && !filesError && <div className="text-[11px] text-muted">Loading…</div>}
              {entries && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {entries.map((entry) => (
                    <button
                      key={entry.path}
                      onClick={() => openFile(entry)}
                      className="w-full flex items-center gap-2 text-[11px] text-left hover:text-accent"
                    >
                      <span className="text-muted">{entry.type === "dir" ? "▸" : "▪"}</span>
                      <span className="truncate flex-1">{entry.name}</span>
                    </button>
                  ))}
                  {entries.length === 0 && <div className="text-[11px] text-muted">Empty directory.</div>}
                </div>
              )}
              {fileView && (
                <div className="mt-2 border border-border rounded-md p-2">
                  <div className="flex items-center gap-2 text-[10px] text-muted mb-1">
                    <span className="truncate flex-1">{fileView.path}</span>
                    {fileView.truncated && <span className="text-amber">truncated</span>}
                    <button onClick={() => setFileView(null)} className="hover:text-text">
                      ×
                    </button>
                  </div>
                  <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                    {fileView.content}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        <TerminalPanel projectId={projectId} nodeId={node.id} ready={ready} />
      </div>
    </>
  );
}

// A minimal streamed shell — plain text, no ANSI rendering, opened on
// request so an idle Inspector doesn't hold a socket open per environment.
function TerminalPanel({ projectId, nodeId, ready }: { projectId: string; nodeId: string; ready: boolean }) {
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<string>("");
  const [cmd, setCmd] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const outRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [lines]);

  function connect() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(environmentTerminalUrl(projectId, nodeId, 100, 30));
    } catch (e) {
      setLines((l) => l + `\n[terminal] ${e instanceof Error ? e.message : "could not connect"}`);
      return;
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const parsed = JSON.parse(ev.data);
          if (parsed.type === "exit") {
            setLines((l) => l + `\n[exit ${parsed.code}]`);
            setConnected(false);
          }
        } catch {
          setLines((l) => l + ev.data);
        }
      } else {
        setLines((l) => l + new TextDecoder().decode(ev.data));
      }
    };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setLines((l) => l + "\n[terminal] connection error");
  }

  function send() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "input", data: cmd + "\n" }));
    setCmd("");
  }

  return (
    <div>
      <SectionLabel>Terminal</SectionLabel>
      {!connected ? (
        <button
          onClick={connect}
          disabled={!ready}
          className="w-full text-[10px] px-2 py-1.5 border border-accent/40 text-accent bg-accent/5 rounded-md disabled:opacity-40"
          title={ready ? undefined : "Environment must be ready first"}
        >
          Connect terminal
        </button>
      ) : (
        <div className="border border-border rounded-md overflow-hidden">
          <pre
            ref={outRef}
            className="bg-black/60 text-[10.5px] leading-relaxed p-2 h-32 overflow-y-auto whitespace-pre-wrap break-all"
          >
            {lines || " "}
          </pre>
          <div className="flex border-t border-border">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="type a command…"
              className="flex-1 bg-panel2 px-2 py-1.5 text-[10.5px] outline-none font-mono"
            />
            <button onClick={send} className="px-2 text-[10px] text-accent">
              ↵
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
