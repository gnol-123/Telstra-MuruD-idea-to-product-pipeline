"use client";

import { useEffect, useState } from "react";
import {
  ProjectNode,
  Edge,
  ToolType,
  ToolCall,
  ToolPolicy,
  isAgentNode,
  isApprovalRequired,
  PendingToolCall,
} from "@/lib/types";
import {
  sendChat,
  streamChat,
  resumeChat,
  verifyNode,
  authorizeNode,
  listToolCalls,
  ApiError,
} from "@/lib/api";

export interface LocalMessage {
  role: "user" | "assistant" | "system";
  content: string;
  pending?: boolean;
}

export interface ChatState {
  messages: LocalMessage[];
  draft: string;
  useStream: boolean;
  busy: boolean;
  pendingCalls: PendingToolCall[] | null;
  approvals: Record<string, boolean>;
}

export function defaultChatState(): ChatState {
  return { messages: [], draft: "", useStream: false, busy: false, pendingCalls: null, approvals: {} };
}

export default function Inspector({
  projectId,
  node,
  nodes,
  edges,
  toolTypes,
  chat,
  onChatChange,
  onUpdateAgentPolicy,
  onRefreshEdge,
  onDeleteEdge,
  onNodeUpdated,
}: {
  projectId: string;
  node: ProjectNode | null;
  nodes: ProjectNode[];
  edges: Edge[];
  toolTypes: ToolType[];
  // Keyed by node id in the parent, so a conversation survives switching
  // away and back — the backend has no endpoint to re-fetch a
  // conversation's history, so once this state is gone it's gone for good.
  chat: ChatState;
  onChatChange: (nodeId: string, updater: (prev: ChatState) => ChatState) => void;
  onUpdateAgentPolicy: (nodeId: string, policy: ToolPolicy) => void;
  onRefreshEdge: (edge: Edge) => void;
  onDeleteEdge: (edge: Edge) => void;
  onNodeUpdated: (node: ProjectNode) => void;
}) {
  if (!node) {
    return (
      <aside className="w-80 shrink-0 border-l border-border p-5 text-sm text-muted">
        Select a node to inspect its tools, context and conversation.
      </aside>
    );
  }

  return (
    <aside className="w-80 shrink-0 border-l border-border flex flex-col min-h-0">
      {isAgentNode(node) ? (
        <AgentInspector
          node={node}
          nodes={nodes}
          edges={edges}
          chat={chat}
          onChatChange={(updater) => onChatChange(node.id, updater)}
          onUpdateAgentPolicy={onUpdateAgentPolicy}
          onRefreshEdge={onRefreshEdge}
          onDeleteEdge={onDeleteEdge}
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
  return (
    <div className="text-[9.5px] tracking-wider uppercase text-white/30 mb-2">
      {children}
    </div>
  );
}

// -------------------- Agent inspector + chat --------------------

function AgentInspector({
  node,
  nodes,
  edges,
  chat,
  onChatChange,
  onUpdateAgentPolicy,
  onRefreshEdge,
  onDeleteEdge,
}: {
  node: Extract<ProjectNode, { kind: "agent" }>;
  nodes: ProjectNode[];
  edges: Edge[];
  chat: ChatState;
  onChatChange: (updater: (prev: ChatState) => ChatState) => void;
  onUpdateAgentPolicy: (nodeId: string, policy: ToolPolicy) => void;
  onRefreshEdge: (edge: Edge) => void;
  onDeleteEdge: (edge: Edge) => void;
}) {
  const inboundTool = edges.filter((e) => e.kind === "tool" && e.target_node_id === node.id);
  const inboundContext = edges.filter((e) => e.kind === "context" && e.target_node_id === node.id);
  const outbound = edges.filter((e) => e.kind === "context" && e.source_node_id === node.id);

  const { messages, draft, useStream, busy, pendingCalls, approvals } = chat;

  async function handleSend() {
    if (!draft.trim() || busy) return;
    const prompt = draft;
    const clientToken = crypto.randomUUID();
    onChatChange((prev) => ({
      ...prev,
      draft: "",
      busy: true,
      messages: [...prev.messages, { role: "user", content: prompt }],
    }));

    if (!useStream) {
      try {
        const res = await sendChat(node.id, prompt, clientToken);
        if (isApprovalRequired(res)) {
          const initial: Record<string, boolean> = {};
          res.pending_calls.forEach((c) => (initial[c.tool_call_id] = true));
          onChatChange((prev) => ({
            ...prev,
            pendingCalls: res.pending_calls,
            approvals: initial,
            messages: [
              ...prev.messages,
              { role: "system", content: `Waiting on approval for ${res.pending_calls.length} tool call(s).` },
            ],
          }));
        } else {
          onChatChange((prev) => ({
            ...prev,
            messages: [...prev.messages, { role: "assistant", content: res.assistant_message.content }],
          }));
        }
      } catch (e: any) {
        onChatChange((prev) => ({
          ...prev,
          messages: [...prev.messages, { role: "assistant", content: `⚠ ${e.message}` }],
        }));
      } finally {
        onChatChange((prev) => ({ ...prev, busy: false }));
      }
      return;
    }

    // Streaming path: append one growing assistant message as chunks arrive.
    onChatChange((prev) => ({
      ...prev,
      messages: [...prev.messages, { role: "assistant", content: "", pending: true }],
    }));
    try {
      await streamChat(node.id, prompt, clientToken, {
        onChunk: (text) => {
          onChatChange((prev) => {
            const copy = [...prev.messages];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { ...last, content: last.content + text };
            return { ...prev, messages: copy };
          });
        },
        onDone: () => {
          onChatChange((prev) => {
            const copy = [...prev.messages];
            copy[copy.length - 1] = { ...copy[copy.length - 1], pending: false };
            return { ...prev, messages: copy };
          });
        },
        onError: (data) => {
          onChatChange((prev) => {
            const copy = [...prev.messages];
            copy[copy.length - 1] = { role: "assistant", content: `⚠ ${data?.message ?? "stream error"}` };
            return { ...prev, messages: copy };
          });
        },
        onApprovalRequired: (data) => {
          const initial: Record<string, boolean> = {};
          (data.pending_calls as PendingToolCall[]).forEach((c) => (initial[c.tool_call_id] = true));
          onChatChange((prev) => {
            const copy = [...prev.messages];
            // The in-progress assistant bubble ends here per API.md — no done event follows.
            copy[copy.length - 1] = { ...copy[copy.length - 1], pending: false };
            copy.push({
              role: "system",
              content: `Waiting on approval for ${data.pending_calls.length} tool call(s).`,
            });
            return { ...prev, messages: copy, pendingCalls: data.pending_calls, approvals: initial };
          });
        },
      });
    } finally {
      onChatChange((prev) => ({ ...prev, busy: false }));
    }
  }

  async function handleResume() {
    onChatChange((prev) => ({ ...prev, busy: true }));
    try {
      const res = await resumeChat(node.id, approvals);
      if (isApprovalRequired(res)) {
        const initial: Record<string, boolean> = {};
        res.pending_calls.forEach((c) => (initial[c.tool_call_id] = true));
        onChatChange((prev) => ({
          ...prev,
          pendingCalls: res.pending_calls,
          approvals: initial,
          messages: [
            ...prev.messages,
            { role: "system", content: `Waiting on approval for ${res.pending_calls.length} more tool call(s).` },
          ],
        }));
      } else {
        onChatChange((prev) => ({
          ...prev,
          pendingCalls: null,
          approvals: {},
          messages: [...prev.messages, { role: "assistant", content: res.assistant_message.content }],
        }));
      }
    } catch (e: any) {
      onChatChange((prev) => ({
        ...prev,
        messages: [...prev.messages, { role: "assistant", content: `⚠ ${e.message}` }],
      }));
    } finally {
      onChatChange((prev) => ({ ...prev, busy: false }));
    }
  }

  return (
    <>
      <div className="px-4 py-3 border-b border-border">
        <div className="text-sm font-medium">{node.name}</div>
        <div className="text-[10px] text-muted">{node.agent_slug}</div>
      </div>

      <div className="px-4 py-3 border-b border-border space-y-3 max-h-[45%] overflow-y-auto">
        <div>
          <SectionLabel>Tool policy</SectionLabel>
          <select
            value={node.tool_policy}
            onChange={(e) => onUpdateAgentPolicy(node.id, e.target.value as ToolPolicy)}
            className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-accent/50"
          >
            <option value="ask">Ask before every tool call</option>
            <option value="auto">Run tools automatically</option>
          </select>
        </div>

        <div>
          <SectionLabel>Tools ({inboundTool.length})</SectionLabel>
          {inboundTool.length === 0 ? (
            <div className="text-[11px] text-muted border border-dashed border-white/15 rounded-md px-2.5 py-2 leading-relaxed">
              Drag a tool from the palette onto the canvas, then link its ◗ port to this agent.
            </div>
          ) : (
            <div className="space-y-1.5">
              {inboundTool.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 text-[11px] bg-accent/5 border border-accent/20 rounded-md px-2 py-1.5"
                >
                  <span className="text-accent text-[10px]">⌗</span>
                  <span className="flex-1 truncate">{nodeName(nodes, e.source_node_id)}</span>
                  <button
                    onClick={() => onDeleteEdge(e)}
                    className="text-white/30 hover:text-white/70"
                    title="Unequip"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionLabel>Inherited context ({inboundContext.length})</SectionLabel>
          {inboundContext.length === 0 ? (
            <div className="text-[11px] text-muted">Runs on its own context only.</div>
          ) : (
            <div className="space-y-1.5">
              {inboundContext.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-[11px]">
                  <span className={e.is_stale ? "text-amber" : "text-accent"}>◗</span>
                  <span className="flex-1 truncate">{nodeName(nodes, e.source_node_id)}</span>
                  {e.summary_updated_at === null ? (
                    <span className="text-amber text-[10px]">no summary yet</span>
                  ) : e.is_stale ? (
                    <button
                      onClick={() => onRefreshEdge(e)}
                      className="text-amber text-[10px] px-1.5 py-0.5 border border-amber/40 rounded"
                    >
                      refresh
                    </button>
                  ) : (
                    <span className="text-muted text-[10px]">synced</span>
                  )}
                  <button onClick={() => onDeleteEdge(e)} className="text-white/30 hover:text-white/70">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {outbound.length > 0 && (
          <div>
            <SectionLabel>Shares with</SectionLabel>
            <div className="space-y-1">
              {outbound.map((e) => (
                <div key={e.id} className="text-[11px] text-white/70">
                  ▸ {nodeName(nodes, e.target_node_id)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        {messages.length === 0 && <div className="text-xs text-muted">No history</div>}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-[240px] text-xs px-3 py-2 rounded-lg text-left ${
                m.role === "user"
                  ? "bg-accent/10 border border-accent/30"
                  : m.role === "system"
                  ? "bg-green/10 border border-green/30 text-green"
                  : "bg-panel2 border border-border"
              }`}
            >
              {m.content || (m.pending ? "…" : "")}
            </div>
          </div>
        ))}

        {pendingCalls && (
          <div className="border border-amber/40 bg-amber/5 rounded-lg p-3 space-y-2">
            <div className="text-[11px] font-medium text-amber">Approval required</div>
            {pendingCalls.map((c) => (
              <label key={c.tool_call_id} className="flex items-start gap-2 text-[11px]">
                <input
                  type="checkbox"
                  checked={approvals[c.tool_call_id] ?? true}
                  onChange={(e) =>
                    onChatChange((prev) => ({
                      ...prev,
                      approvals: { ...prev.approvals, [c.tool_call_id]: e.target.checked },
                    }))
                  }
                  className="mt-0.5 accent-amber"
                />
                <span>
                  <span className="font-medium">{c.tool_name}</span>
                  <span className="block text-muted text-[10px] break-all">
                    {JSON.stringify(c.arguments)}
                  </span>
                </span>
              </label>
            ))}
            <button
              onClick={handleResume}
              disabled={busy}
              className="w-full bg-amber text-[#2b1a00] font-medium rounded-md py-1.5 text-xs disabled:opacity-50"
            >
              {busy ? "Resuming…" : "Resume with these decisions"}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3 space-y-2">
        <label className="flex items-center gap-2 text-[10px] text-muted">
          <input
            type="checkbox"
            checked={useStream}
            onChange={(e) => onChatChange((prev) => ({ ...prev, useStream: e.target.checked }))}
            className="accent-accent"
          />
          Stream response (chat/stream)
        </label>
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => onChatChange((prev) => ({ ...prev, draft: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Message this agent…"
            disabled={!!pendingCalls}
            className="flex-1 bg-panel2 border border-border rounded-md px-3 py-2 text-xs outline-none focus:border-accent/50 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={busy || !!pendingCalls}
            className="bg-accent/15 text-accent border border-accent/40 rounded-md px-3 py-2 text-xs disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </>
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
      <div className="px-4 py-3 border-b border-border">
        <div className="text-sm font-medium">{node.name}</div>
        <div className="text-[10px] text-muted">{node.tool_slug}</div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
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
              Drag this tool&apos;s ◗ port onto an agent card to make it callable there.
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
