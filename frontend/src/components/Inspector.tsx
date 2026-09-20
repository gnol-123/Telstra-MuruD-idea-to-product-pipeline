"use client";

import { useEffect, useRef, useState } from "react";
import {
  ProjectNode,
  Edge,
  ToolType,
  ToolCall,
  ToolPolicy,
  EnvironmentFileEntry,
  isAgentNode,
  isEnvironmentNode,
  isApprovalRequired,
  PendingToolCall,
} from "@/lib/types";
import {
  sendChat,
  streamChat,
  attachChat,
  cancelChat,
  resumeChat,
  verifyNode,
  authorizeNode,
  listToolCalls,
  listNodeMessages,
  updateEnvironment,
  startEnvironment,
  stopEnvironment,
  verifyEnvironment,
  listEnvironmentFiles,
  readEnvironmentFile,
  getEnvironmentPreview,
  environmentTerminalUrl,
  StreamHandlers,
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
  // True once this node's history has been fetched from the backend (or
  // that fetch failed and isn't worth retrying every render). Without this,
  // a freshly opened tab / reloaded project has no idea the conversation
  // already has a transcript sitting in the database.
  historyLoaded: boolean;
}

export function defaultChatState(): ChatState {
  return {
    messages: [],
    draft: "",
    useStream: false,
    busy: false,
    pendingCalls: null,
    approvals: {},
    historyLoaded: false,
  };
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
  onUnequipTool,
  onNodeUpdated,
  onAfterTurn,
}: {
  projectId: string;
  node: ProjectNode | null;
  nodes: ProjectNode[];
  edges: Edge[];
  toolTypes: ToolType[];
  // Keyed by node id in the parent, so a conversation survives switching
  // between nodes within the same tab. The backend transcript is the real
  // source of truth on first open — see the historyLoaded fetch below.
  chat: ChatState;
  onChatChange: (nodeId: string, updater: (prev: ChatState) => ChatState) => void;
  onUpdateAgentPolicy: (nodeId: string, policy: ToolPolicy) => void;
  onRefreshEdge: (edge: Edge) => void;
  onDeleteEdge: (edge: Edge) => void;
  // Tool edges specifically: removes the edge AND nudges the now-bare tool
  // node back into view near its former agent (see MeshCanvas).
  onUnequipTool: (edge: Edge) => void;
  onNodeUpdated: (node: ProjectNode) => void;
  // Called after every chat turn settles (sent, streamed, or resumed). An
  // orchestrator's Canvas tool can create/wire other nodes mid-turn, and
  // those never show up on the canvas until something re-fetches it — this
  // is that re-fetch, cheap enough to run after any agent's turn too.
  onAfterTurn: () => void;
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
          key={node.id}
          projectId={projectId}
          node={node}
          nodes={nodes}
          edges={edges}
          chat={chat}
          onChatChange={(updater) => onChatChange(node.id, updater)}
          onUpdateAgentPolicy={onUpdateAgentPolicy}
          onRefreshEdge={onRefreshEdge}
          onDeleteEdge={onDeleteEdge}
          onUnequipTool={onUnequipTool}
          onAfterTurn={onAfterTurn}
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
  return (
    <div className="text-[9.5px] tracking-wider uppercase text-white/30 mb-2">
      {children}
    </div>
  );
}

// -------------------- Agent inspector + chat --------------------

// Shared between the initial POST /chat/stream call (handleSend) and a
// GET /chat/attach re-join (the historyLoaded effect below) — both emit the
// identical SSE event shape per API.md, so the UI reaction to each event
// only needs to exist once.
function makeStreamHandlers(
  onChatChange: (updater: (prev: ChatState) => ChatState) => void
): StreamHandlers {
  return {
    onChunk: (text) => {
      onChatChange((prev) => {
        const copy = [...prev.messages];
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = { ...last, content: last.content + text };
        return { ...prev, messages: copy };
      });
    },
    onTool: (data) => {
      // event: tool — fired once when a tool/sub-agent is called and again
      // with its result_head when it returns. Surfaced as its own
      // system-style line rather than mixed into the assistant's prose, and
      // the in-flight bubble is left alone so its text keeps growing
      // underneath.
      const label =
        "result_head" in data
          ? `↳ ${data.name} → ${String(data.result_head ?? "").slice(0, 140)}`
          : `⚙ calling ${data.name}${data.args ? ` ${JSON.stringify(data.args).slice(0, 140)}` : ""}`;
      onChatChange((prev) => {
        const copy = [...prev.messages];
        // Insert the tool note before the trailing (still-growing) assistant
        // bubble so the assistant's reply stays last.
        const pendingIdx = copy.length - 1;
        const before = copy.slice(0, pendingIdx);
        const after = copy.slice(pendingIdx);
        return { ...prev, messages: [...before, { role: "system", content: label }, ...after] };
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
      // The backend's SSE payload is {"error": str(exc)} (see workflows.py's
      // stream_turn) — data.message rarely exists, so fall through every key
      // the backend could plausibly use before giving up and dumping the raw
      // payload, rather than showing the uninformative literal "stream error".
      const detail =
        data?.message ?? data?.detail ?? data?.error ?? data?.reason ??
        (data && Object.keys(data).length ? JSON.stringify(data) : null) ??
        "the backend closed the stream with no error detail — check its logs for a traceback";
      onChatChange((prev) => {
        const copy = [...prev.messages];
        copy[copy.length - 1] = { role: "assistant", content: `⚠ ${detail}` };
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
  };
}

function AgentInspector({
  projectId,
  node,
  nodes,
  edges,
  chat,
  onChatChange,
  onUpdateAgentPolicy,
  onRefreshEdge,
  onDeleteEdge,
  onUnequipTool,
  onAfterTurn,
}: {
  projectId: string;
  node: Extract<ProjectNode, { kind: "agent" }>;
  nodes: ProjectNode[];
  edges: Edge[];
  chat: ChatState;
  onChatChange: (updater: (prev: ChatState) => ChatState) => void;
  onUpdateAgentPolicy: (nodeId: string, policy: ToolPolicy) => void;
  onRefreshEdge: (edge: Edge) => void;
  onDeleteEdge: (edge: Edge) => void;
  onUnequipTool: (edge: Edge) => void;
  onAfterTurn: () => void;
}) {
  const inboundTool = edges.filter((e) => e.kind === "tool" && e.target_node_id === node.id);
  const inboundEnv = edges.filter((e) => e.kind === "environment" && e.target_node_id === node.id);
  const inboundContext = edges.filter((e) => e.kind === "context" && e.target_node_id === node.id);
  const outbound = edges.filter((e) => e.kind === "context" && e.source_node_id === node.id);

  const { messages, draft, useStream, busy, pendingCalls, approvals, historyLoaded } = chat;

  // Hydrate this node's transcript from the backend the first time it's
  // opened. Runs once per node (the `key={node.id}` on AgentInspector
  // remounts this on every switch, and historyLoaded guards against
  // re-fetching on every re-render of the same node).
  useEffect(() => {
    if (historyLoaded) return;
    let cancelled = false;
    listNodeMessages(projectId, node.id)
      .then((history) => {
        if (cancelled) return;
        const fetched: LocalMessage[] = history
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role,
            content: m.status === "failed" ? m.content || "⚠ This turn failed." : m.content,
            // A turn still streaming when we fetched — seed the bubble as
            // pending so it renders like one we started ourselves, and reach
            // out below to pick the live stream back up.
            pending: m.status === "running" ? true : undefined,
          }));
        const last = history[history.length - 1];
        const stillRunning = !!last && last.role === "assistant" && last.status === "running";

        onChatChange((prev) =>
          prev.historyLoaded
            ? prev
            : {
                ...prev,
                historyLoaded: true,
                messages: [...fetched, ...prev.messages],
                busy: stillRunning ? true : prev.busy,
              }
        );

        if (!stillRunning) return;

        // Re-join the turn that was already in flight (e.g. this tab was
        // reloaded, or the turn was started from another tab) instead of
        // leaving the bubble stuck on "…" forever.
        attachChat(node.id, makeStreamHandlers(onChatChange))
          .then((attached) => {
            if (cancelled || attached) return;
            // 204 — the backend has nothing running any more (it finished
            // between our GET and this attach). Re-fetch just the tail to
            // pick up the final content instead of leaving a stale pending
            // bubble on screen.
            listNodeMessages(projectId, node.id, Math.max(0, (last.seq ?? 1) - 1))
              .then((tail) => {
                if (cancelled || tail.length === 0) return;
                const finalMsg = tail[tail.length - 1];
                onChatChange((prev) => {
                  const copy = [...prev.messages];
                  if (copy.length > 0) {
                    copy[copy.length - 1] = {
                      role: "assistant",
                      content:
                        finalMsg.status === "failed"
                          ? finalMsg.content || "⚠ This turn failed."
                          : finalMsg.content,
                    };
                  }
                  return { ...prev, messages: copy };
                });
              })
              .catch(() => {});
          })
          .catch(() => {})
          .finally(() => {
            if (!cancelled) {
              onChatChange((prev) => ({ ...prev, busy: false }));
              onAfterTurn();
            }
          });
      })
      .catch(() => {
        // Don't retry forever on every re-render if the fetch failed —
        // the user can still chat, it just starts from a blank transcript.
        if (!cancelled) onChatChange((prev) => ({ ...prev, historyLoaded: true }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

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
        // A Canvas-equipped orchestrator can create/wire nodes as part of
        // this turn; pick those up now instead of waiting for some other
        // action to trigger a reload.
        onAfterTurn();
      }
      return;
    }

    // Streaming path: append one growing assistant message as chunks arrive.
    onChatChange((prev) => ({
      ...prev,
      messages: [...prev.messages, { role: "assistant", content: "", pending: true }],
    }));
    try {
      await streamChat(node.id, prompt, clientToken, makeStreamHandlers(onChatChange));
    } finally {
      onChatChange((prev) => ({ ...prev, busy: false }));
      onAfterTurn();
    }
  }

  // Stops a turn in flight — streamed, non-streamed, or parked on an
  // approval. The stream (if one is open, ours or a re-joined /chat/attach)
  // closes on its own once the backend finalises the message as
  // status: "cancelled"; nothing here needs to touch `messages` directly.
  async function handleCancel() {
    try {
      await cancelChat(node.id);
    } catch {
      // 409 means there was nothing left to stop (it just finished) — either
      // way there's nothing more for the client to do.
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
      onAfterTurn();
    }
  }

  return (
    <>
      <div className="px-4 py-3 border-b border-border">
        <div className="text-sm font-medium">{node.name}</div>
        <div className="text-[10px] text-muted">{node.agent_slug}</div>
      </div>

      <div className="px-4 py-3 border-b border-border space-y-3 max-h-[48%] overflow-y-auto">
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
              Drop a tool card from the palette straight onto this agent's card to equip it.
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
                    onClick={() => onUnequipTool(e)}
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
          <SectionLabel>Environments ({inboundEnv.length})</SectionLabel>
          {inboundEnv.length === 0 ? (
            <div className="text-[11px] text-muted">
              No sandbox linked — this agent uses the project's shared scratch environment only.
            </div>
          ) : (
            <div className="space-y-1.5">
              {inboundEnv.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 text-[11px] bg-green/5 border border-green/20 rounded-md px-2 py-1.5"
                >
                  <span className="text-green text-[10px]">▣</span>
                  <span className="flex-1 truncate">{nodeName(nodes, e.source_node_id)}</span>
                  <button onClick={() => onDeleteEdge(e)} className="text-white/30 hover:text-white/70" title="Unlink">
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
          Stream response (chat/stream) — shows tool checkpoints live
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
          {busy ? (
            <button
              onClick={handleCancel}
              title="Stop this turn (POST /chat/cancel)"
              className="bg-red-500/15 text-red-300 border border-red-500/40 rounded-md px-3 py-2 text-xs"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!!pendingCalls}
              className="bg-accent/15 text-accent border border-accent/40 rounded-md px-3 py-2 text-xs disabled:opacity-50"
            >
              Send
            </button>
          )}
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
      <div className="px-4 py-3 border-b border-border">
        <div className="text-sm font-medium">{node.name}</div>
        <div className="text-[10px] text-muted">
          {node.runtime} sandbox · {node.role === "scratch" ? "shared scratch space" : "user-provisioned"}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
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
          <SectionLabel>Identity</SectionLabel>
          <div className="flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 bg-panel2 border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-accent/50"
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
