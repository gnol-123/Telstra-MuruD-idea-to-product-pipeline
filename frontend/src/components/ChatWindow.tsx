"use client";

import { useEffect, useRef, useState } from "react";
import { AgentNode, Edge, ProjectNode, PendingToolCall, isApprovalRequired, isToolNode } from "@/lib/types";
import {
  sendChat,
  streamChat,
  attachChat,
  cancelChat,
  resumeChat,
  listNodeMessages,
  StreamHandlers,
} from "@/lib/api";
import { AGENT_ICONS, ENV_ICON, TOOL_ICONS, agentRole } from "./NodeCard";

// -------------------- chat state (lifted to MeshCanvas, keyed by node) --------------------

export interface LocalMessage {
  role: "user" | "assistant" | "system";
  content: string;
  pending?: boolean;
  // Only for role: "system" — picks the row style. "tool" is a live
  // tool/sub-agent checkpoint, "warn" an approval pause, "ok" a context
  // refresh confirmation.
  tone?: "tool" | "warn" | "ok";
}

export interface ChatState {
  messages: LocalMessage[];
  draft: string;
  useStream: boolean;
  busy: boolean;
  pendingCalls: PendingToolCall[] | null;
  approvals: Record<string, boolean>;
  // True once this node's history has been fetched from the backend (or
  // that fetch failed and isn't worth retrying). Without this a reopened
  // project has no idea the conversation already has a transcript.
  historyLoaded: boolean;
}

export function defaultChatState(): ChatState {
  return {
    messages: [],
    draft: "",
    useStream: true,
    busy: false,
    pendingCalls: null,
    approvals: {},
    historyLoaded: false,
  };
}

type ChatUpdater = (updater: (prev: ChatState) => ChatState) => void;

// Shared between POST /chat/stream (send) and GET /chat/attach (re-join) —
// both emit the identical SSE event shape per API.md.
function makeStreamHandlers(onChatChange: ChatUpdater): StreamHandlers {
  const replaceLast = (fn: (m: LocalMessage) => LocalMessage) =>
    onChatChange((prev) => {
      if (prev.messages.length === 0) return prev;
      const copy = [...prev.messages];
      copy[copy.length - 1] = fn(copy[copy.length - 1]);
      return { ...prev, messages: copy };
    });

  return {
    onChunk: (text) => replaceLast((m) => ({ ...m, content: m.content + text })),
    onTool: (data) => {
      // event: tool — fired when a tool/sub-agent is called and again with
      // its result_head when it returns. Rendered as its own checkpoint row,
      // inserted above the still-growing assistant reply.
      const label =
        "result_head" in data
          ? `↳ ${data.name} → ${String(data.result_head ?? "").slice(0, 160)}`
          : `⚙ calling ${data.name}${data.args ? ` ${JSON.stringify(data.args).slice(0, 160)}` : ""}`;
      onChatChange((prev) => {
        const copy = [...prev.messages];
        const idx = copy.length - 1;
        return {
          ...prev,
          messages: [...copy.slice(0, idx), { role: "system", tone: "tool", content: label }, ...copy.slice(idx)],
        };
      });
    },
    onDone: (data) => {
      // `done` carries the final assistant_message; a cancelled turn keeps
      // its partial text and finalises with status "cancelled".
      const status = data?.assistant_message?.status;
      replaceLast((m) => ({
        ...m,
        pending: false,
        content:
          status === "cancelled"
            ? `${m.content}${m.content ? "\n\n" : ""}⏹ Stopped.`
            : m.content || data?.assistant_message?.content || m.content,
      }));
    },
    onError: (data) => {
      // The backend's SSE payload is {"error": str(exc)} — fall through
      // every key it could plausibly use before dumping the raw payload.
      const detail =
        data?.message ??
        data?.detail ??
        data?.error ??
        data?.reason ??
        (data && Object.keys(data).length ? JSON.stringify(data) : null) ??
        "the backend closed the stream with no error detail — check its logs for a traceback";
      replaceLast(() => ({ role: "assistant", content: `⚠ ${detail}` }));
    },
    onApprovalRequired: (data) => {
      const initial: Record<string, boolean> = {};
      (data.pending_calls as PendingToolCall[]).forEach((c) => (initial[c.tool_call_id] = true));
      onChatChange((prev) => {
        const copy = [...prev.messages];
        // The in-progress assistant bubble ends here per API.md — no done event follows.
        if (copy.length) {
          const last = copy[copy.length - 1];
          if (last.role === "assistant" && !last.content) copy.pop();
          else copy[copy.length - 1] = { ...last, pending: false };
        }
        copy.push({
          role: "system",
          tone: "warn",
          content: `Waiting on approval for ${data.pending_calls.length} tool call(s).`,
        });
        return { ...prev, messages: copy, pendingCalls: data.pending_calls, approvals: initial };
      });
    },
  };
}

// -------------------- the window --------------------

export default function ChatWindow({
  projectId,
  node,
  nodes,
  edges,
  chat,
  onChatChange,
  onClose,
  onAfterTurn,
  onRefreshEdge,
}: {
  projectId: string;
  node: AgentNode;
  nodes: ProjectNode[];
  edges: Edge[];
  chat: ChatState;
  onChatChange: ChatUpdater;
  onClose: () => void;
  // Called after every turn settles — an orchestrator's Canvas tool can
  // create/wire nodes mid-turn, so the canvas re-fetches here.
  onAfterTurn: () => void;
  onRefreshEdge: (edge: Edge) => Promise<void>;
}) {
  const { messages, draft, useStream, busy, pendingCalls, approvals, historyLoaded } = chat;
  const icon = AGENT_ICONS[node.agent_slug] ?? "◆";
  const nameOf = (id: string) => nodes.find((n) => n.id === id);

  const upstream = edges.filter((e) => e.kind === "context" && e.target_node_id === node.id);
  const toolEdges = edges.filter((e) => e.kind === "tool" && e.target_node_id === node.id);
  const envEdges = edges.filter((e) => e.kind === "environment" && e.target_node_id === node.id);
  const stale = upstream.filter((e) => e.is_stale);

  const [staleAsk, setStaleAsk] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Esc closes, like the mockup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the newest message in view as history loads / chunks stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pendingCalls, staleAsk]);

  // Hydrate the transcript from the backend the first time this agent's
  // chat is opened, and re-join a turn that's still running (reload, or a
  // second tab) via GET /chat/attach.
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
            content:
              m.status === "failed"
                ? m.content || "⚠ This turn failed."
                : m.status === "cancelled"
                ? `${m.content}${m.content ? "\n\n" : ""}⏹ Stopped.`
                : m.content,
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
        attachChat(node.id, makeStreamHandlers(onChatChange))
          .then((attached) => {
            if (cancelled || attached) return;
            // 204 — it finished between our GET and the attach; pull the
            // final text instead of leaving a stale "…" bubble.
            listNodeMessages(projectId, node.id, Math.max(0, (last.seq ?? 1) - 1))
              .then((tail) => {
                if (cancelled || tail.length === 0) return;
                const finalMsg = tail[tail.length - 1];
                onChatChange((prev) => {
                  const copy = [...prev.messages];
                  if (copy.length > 0) {
                    copy[copy.length - 1] = {
                      role: "assistant",
                      content: finalMsg.status === "failed" ? finalMsg.content || "⚠ This turn failed." : finalMsg.content,
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
        if (!cancelled) onChatChange((prev) => ({ ...prev, historyLoaded: true }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  async function clearStale() {
    if (stale.length === 0) return;
    setClearing(true);
    try {
      await Promise.all(stale.map((e) => onRefreshEdge(e)));
      const names = stale.map((e) => nameOf(e.source_node_id)?.name ?? "upstream").join(" and ");
      onChatChange((prev) => ({
        ...prev,
        messages: [
          ...prev.messages,
          { role: "system", tone: "ok", content: `Stale context cleared — now running on the latest output from ${names}.` },
        ],
      }));
    } finally {
      setClearing(false);
    }
  }

  async function send(prompt: string, force = false) {
    const text = prompt.trim();
    if (!text || busy) return;
    // Mockup behaviour: sending on top of out-of-date upstream context asks
    // first, since the agent would otherwise answer from a stale snapshot.
    if (stale.length > 0 && !force) {
      setStaleAsk(text);
      return;
    }
    setStaleAsk(null);
    const clientToken = crypto.randomUUID();
    onChatChange((prev) => ({
      ...prev,
      draft: "",
      busy: true,
      messages: [...prev.messages, { role: "user", content: text }],
    }));

    if (!useStream) {
      onChatChange((prev) => ({
        ...prev,
        messages: [...prev.messages, { role: "assistant", content: "", pending: true }],
      }));
      try {
        const res = await sendChat(node.id, text, clientToken);
        if (isApprovalRequired(res)) {
          const initial: Record<string, boolean> = {};
          res.pending_calls.forEach((c) => (initial[c.tool_call_id] = true));
          onChatChange((prev) => ({
            ...prev,
            pendingCalls: res.pending_calls,
            approvals: initial,
            messages: [
              ...prev.messages.slice(0, -1),
              { role: "system", tone: "warn", content: `Waiting on approval for ${res.pending_calls.length} tool call(s).` },
            ],
          }));
        } else {
          onChatChange((prev) => ({
            ...prev,
            messages: [...prev.messages.slice(0, -1), { role: "assistant", content: res.assistant_message.content }],
          }));
        }
      } catch (e: any) {
        onChatChange((prev) => ({
          ...prev,
          messages: [...prev.messages.slice(0, -1), { role: "assistant", content: `⚠ ${e.message}` }],
        }));
      } finally {
        onChatChange((prev) => ({ ...prev, busy: false }));
        onAfterTurn();
      }
      return;
    }

    onChatChange((prev) => ({
      ...prev,
      messages: [...prev.messages, { role: "assistant", content: "", pending: true }],
    }));
    try {
      await streamChat(node.id, text, clientToken, makeStreamHandlers(onChatChange));
    } catch (e: any) {
      onChatChange((prev) => {
        const copy = [...prev.messages];
        copy[copy.length - 1] = { role: "assistant", content: `⚠ ${e?.message ?? "stream failed"}` };
        return { ...prev, messages: copy };
      });
    } finally {
      // Safety net: never leave a bubble spinning once the stream has ended.
      onChatChange((prev) => ({
        ...prev,
        busy: false,
        messages: prev.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
      }));
      onAfterTurn();
    }
  }

  // POST /chat/cancel — stops a streamed, non-streamed, or approval-parked
  // turn. The open stream closes itself once the backend finalises the
  // message as "cancelled".
  async function stop() {
    try {
      await cancelChat(node.id);
    } catch {
      // 409 = nothing left to stop.
    }
    if (pendingCalls) {
      onChatChange((prev) => ({
        ...prev,
        pendingCalls: null,
        approvals: {},
        messages: [...prev.messages, { role: "system", tone: "warn", content: "Turn stopped — pending tool calls were discarded." }],
      }));
    }
  }

  async function resume() {
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
            { role: "system", tone: "warn", content: `Waiting on approval for ${res.pending_calls.length} more tool call(s).` },
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

  const canSend = !!draft.trim() && !busy && !pendingCalls;
  const scopeCount = upstream.length + 1;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/[0.66] backdrop-blur-[3px] grid place-items-center p-9 anim-fadein"
      onClick={onClose}
    >
      <div
        className="w-[min(880px,100%)] h-[min(660px,100%)] bg-modal border border-accent/[0.34] rounded-2xl shadow-[0_40px_120px_rgba(0,0,0,.8),0_0_70px_rgba(34,224,240,.09)] flex flex-col overflow-hidden anim-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex-none flex items-center gap-3 px-[18px] py-[15px] border-b border-white/[0.09]">
          <div className="w-8 h-8 rounded-lg border border-accent/[0.55] grid place-items-center text-accent text-sm">{icon}</div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{node.name}</div>
            <div className="text-[10.5px] text-white/40 mt-0.5 truncate">{agentRole(node.agent_slug)}</div>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            {busy && (
              <span className="flex items-center gap-1.5 text-[10.5px] text-green">
                <span className="w-[5px] h-[5px] rounded-full bg-green anim-softpulse" />
                running
              </span>
            )}
            <span className="text-[10.5px] text-white/40 px-2.5 py-[5px] border border-white/[0.12] rounded-md whitespace-nowrap">
              {toolEdges.length} tool{toolEdges.length === 1 ? "" : "s"} · {upstream.length} inherited
              {envEdges.length > 0 ? ` · ${envEdges.length} env` : ""}
            </span>
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="w-[30px] h-[30px] rounded-[7px] border border-white/[0.14] text-white/[0.55] hover:text-text hover:border-white/30 text-sm"
            >
              ×
            </button>
          </div>
        </div>

        {/* context in scope */}
        <div className="flex-none flex items-center gap-[7px] flex-wrap px-[18px] py-2.5 border-b border-white/[0.07] bg-accent/[0.02]">
          <span className="text-[9.5px] tracking-[0.11em] uppercase text-white/30 mr-0.5">Context in scope</span>
          {upstream.length === 0 && (
            <span className="text-[10.5px] text-white/[0.34]">own transcript only — link a port on the canvas to share more</span>
          )}
          {upstream.map((e) => {
            const src = nameOf(e.source_node_id);
            const st = e.is_stale;
            return (
              <span
                key={e.id}
                title={st ? "Upstream output has changed since this agent last pulled its summary" : "Synced summary"}
                className={`inline-flex items-center gap-[5px] px-[9px] py-1 rounded-full text-[10.5px] border ${
                  st ? "bg-amber/10 border-amber/45 text-amber" : "bg-accent/10 border-accent/[0.35] text-accent"
                }`}
              >
                <span className="text-[9px] opacity-80">
                  {src && src.kind === "agent" ? AGENT_ICONS[src.agent_slug] ?? "◆" : "◆"}
                </span>
                {src?.name ?? "Unknown"}
                {st && <span className="text-[9px] tracking-[0.06em]">· STALE</span>}
              </span>
            );
          })}
          {envEdges.map((e) => (
            <span
              key={e.id}
              className="inline-flex items-center gap-[5px] px-[9px] py-1 rounded-full text-[10.5px] bg-green/10 border border-green/[0.35] text-green"
            >
              <span className="text-[9px] opacity-80">{ENV_ICON}</span>
              {nameOf(e.source_node_id)?.name ?? "Sandbox"}
            </span>
          ))}
          {toolEdges.map((e) => {
            const t = nameOf(e.source_node_id);
            return (
              <span
                key={e.id}
                className="inline-flex items-center gap-[5px] px-[9px] py-1 rounded-full text-[10.5px] bg-white/[0.04] border border-white/[0.12] text-white/[0.55]"
              >
                <span className="text-[9px] opacity-70">{t && isToolNode(t) ? TOOL_ICONS[t.tool_slug] ?? "◆" : "◆"}</span>
                {t?.name ?? "Tool"}
              </span>
            );
          })}
        </div>

        {/* messages */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-[18px] py-5 flex flex-col gap-[18px] select-text">
          {!historyLoaded && messages.length === 0 && (
            <div className="m-auto text-xs text-white/[0.35]">Loading conversation…</div>
          )}
          {historyLoaded && messages.length === 0 && (
            <div className="m-auto text-center max-w-sm">
              <div className="mx-auto w-11 h-11 rounded-xl border border-accent/40 grid place-items-center text-accent text-lg">
                {icon}
              </div>
              <div className="mt-3 text-sm font-medium">Start a conversation with {node.name}</div>
              <div className="mt-1.5 text-[11.5px] text-white/40 leading-relaxed">
                {toolEdges.length ? `${toolEdges.length} tool${toolEdges.length === 1 ? "" : "s"} equipped` : "No tools equipped"}
                {upstream.length
                  ? ` · inherits context from ${upstream.map((e) => nameOf(e.source_node_id)?.name).join(", ")}`
                  : " · runs on its own context"}
                .
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            if (m.role === "system") {
              const tone =
                m.tone ??
                (m.content.startsWith("⚙") || m.content.startsWith("↳")
                  ? "tool"
                  : m.content.startsWith("Waiting")
                  ? "warn"
                  : "ok");
              if (tone === "tool") {
                return (
                  <div
                    key={i}
                    className="ml-[41px] font-mono text-[10.5px] leading-relaxed text-white/50 border-l-2 border-accent/30 pl-3 py-0.5 break-all"
                  >
                    {m.content}
                  </div>
                );
              }
              return (
                <div
                  key={i}
                  className={`flex items-center gap-[9px] px-3 py-[9px] rounded-[9px] text-[11.5px] border ${
                    tone === "warn"
                      ? "bg-amber/[0.06] border-amber/[0.28] text-[#ffd9a0]"
                      : "bg-green/[0.06] border-green/[0.28] text-[rgba(190,240,195,.9)]"
                  }`}
                >
                  <span className={`text-[11px] ${tone === "warn" ? "text-amber" : "text-green"}`}>
                    {tone === "warn" ? "⏸" : "⟳"}
                  </span>
                  {m.content}
                </div>
              );
            }
            const mine = m.role === "user";
            const failed = !mine && m.content.startsWith("⚠");
            return (
              <div key={i} className="flex gap-[11px]">
                <div
                  className={`flex-none w-[30px] h-[30px] rounded-full grid place-items-center font-semibold ${
                    mine
                      ? "bg-white/[0.07] text-white/60 text-[9.5px]"
                      : "border border-accent/[0.55] text-accent text-xs"
                  }`}
                >
                  {mine ? "ME" : icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold mb-1.5">{mine ? "You" : node.name}</div>
                  <div
                    className={`rounded-[10px] px-3.5 py-3 text-[13px] leading-[1.6] whitespace-pre-wrap break-words border ${
                      mine
                        ? "bg-white/[0.04] border-white/[0.07] text-white/[0.76]"
                        : failed
                        ? "border-red-400/30 bg-red-400/[0.04] text-red-300"
                        : "border-white/[0.09] text-white/[0.76]"
                    }`}
                  >
                    {m.content}
                    {m.pending && (
                      <span className="inline-block ml-0.5 text-accent anim-softpulse">{m.content ? "▍" : "Thinking…"}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* composer */}
        <div className="flex-none px-[18px] pt-3.5 pb-[18px]">
          {pendingCalls && (
            <div className="mb-2.5 border border-amber/45 bg-amber/[0.07] rounded-[11px] px-3.5 py-3 anim-pop">
              <div className="flex items-center gap-2">
                <span className="text-amber text-[13px]">⏸</span>
                <div className="text-[12.5px] font-semibold text-[#ffd9a0]">
                  Approve {pendingCalls.length === 1 ? "this tool call" : `these ${pendingCalls.length} tool calls`}?
                </div>
              </div>
              <div className="mt-2.5 space-y-2 max-h-36 overflow-auto">
                {pendingCalls.map((c) => (
                  <label key={c.tool_call_id} className="flex items-start gap-2 text-[11.5px] cursor-pointer">
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
                    <span className="min-w-0">
                      <span className="font-medium text-text">{c.tool_name}</span>
                      <span className="block font-mono text-white/45 text-[10px] break-all">{JSON.stringify(c.arguments)}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <button
                  onClick={resume}
                  disabled={busy}
                  className="bg-amber text-[#2b1a00] rounded-[7px] px-3.5 py-2 text-[11.5px] font-semibold disabled:opacity-50"
                >
                  {busy ? "Resuming…" : "Resume with these decisions"}
                </button>
                <button
                  onClick={stop}
                  className="ml-auto text-[11.5px] text-white/[0.38] hover:text-white/70"
                >
                  Stop turn
                </button>
              </div>
            </div>
          )}

          {staleAsk !== null && !pendingCalls && (
            <div className="mb-2.5 border border-amber/45 bg-amber/[0.07] rounded-[11px] px-3.5 py-[13px] anim-pop">
              <div className="flex items-start gap-2.5">
                <span className="text-amber text-[13px] leading-tight">⟳</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold text-[#ffd9a0]">Clear stale context before sending?</div>
                  <div className="mt-[5px] text-[11.5px] leading-[1.55] text-white/60">
                    {stale.map((e) => nameOf(e.source_node_id)?.name).join(" and ")} produced new output after this agent last
                    pulled context. Sending now prompts {node.name} on a stale snapshot.
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <button
                  disabled={clearing}
                  onClick={async () => {
                    const text = staleAsk;
                    await clearStale();
                    send(text, true);
                  }}
                  className="bg-amber text-[#2b1a00] rounded-[7px] px-3.5 py-2 text-[11.5px] font-semibold disabled:opacity-60"
                >
                  {clearing ? "Clearing…" : "⟳ Clear stale context & send"}
                </button>
                <button
                  onClick={() => send(staleAsk, true)}
                  className="border border-white/[0.16] text-white/60 hover:text-text rounded-[7px] px-3 py-2 text-[11.5px]"
                >
                  Send on stale context
                </button>
                <button onClick={() => setStaleAsk(null)} className="ml-auto text-[11.5px] text-white/[0.38] hover:text-white/70">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {staleAsk === null && !pendingCalls && stale.length > 0 && (
            <div className="mb-2.5 flex flex-wrap items-center gap-[9px] px-3 py-[9px] rounded-[9px] border border-amber/30 bg-amber/[0.05]">
              <span className="text-amber text-[11px]">⟳</span>
              <span className="flex-1 min-w-[150px] text-[11.5px] leading-[1.4] text-white/[0.62]">
                {stale.length} shared context source{stale.length === 1 ? "" : "s"} out of date
              </span>
              <button
                disabled={clearing}
                onClick={clearStale}
                className="bg-amber text-[#2b1a00] rounded-md px-3 py-1.5 text-[11px] font-semibold disabled:opacity-60"
              >
                {clearing ? "Clearing…" : "⟳ Clear stale context"}
              </button>
            </div>
          )}

          <div
            className={`border rounded-[11px] bg-white/[0.02] px-[13px] py-3 transition-colors focus-within:border-accent/40 ${
              staleAsk !== null ? "border-amber/40" : "border-white/[0.13]"
            }`}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              disabled={!!pendingCalls}
              onChange={(e) => onChatChange((prev) => ({ ...prev, draft: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              placeholder={pendingCalls ? "Approve or stop the pending tool calls first…" : `Message ${node.name}…`}
              className="w-full resize-none bg-transparent border-none outline-none text-text text-[13px] px-0.5 pt-0.5 pb-3 max-h-40 placeholder:text-white/[0.35] disabled:opacity-50"
              style={{ fieldSizing: "content" } as React.CSSProperties}
            />
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] text-white/[0.34] truncate">
                {upstream.length ? `Replies use ${scopeCount} merged context sources` : "Replies use this thread only"}
              </span>
              <button
                onClick={() => onChatChange((prev) => ({ ...prev, useStream: !prev.useStream }))}
                title="Stream the reply token-by-token (POST /chat/stream) and show tool checkpoints live"
                className={`ml-auto shrink-0 flex items-center gap-1.5 text-[10.5px] rounded-md px-2 py-1 border transition-colors ${
                  useStream ? "border-accent/30 text-accent/80" : "border-white/[0.12] text-white/40 hover:text-white/60"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${useStream ? "bg-accent" : "bg-white/30"}`} />
                Live stream
              </button>
              {busy && !pendingCalls ? (
                <button
                  onClick={stop}
                  title="Stop this turn (POST /chat/cancel)"
                  className="shrink-0 bg-red-500/15 text-red-300 border border-red-500/40 hover:bg-red-500/25 rounded-lg px-4 py-2 text-[12.5px] font-semibold"
                >
                  ■ Stop
                </button>
              ) : (
                <button
                  onClick={() => send(draft)}
                  disabled={!canSend}
                  className={`shrink-0 rounded-lg px-4 py-2 text-[12.5px] font-semibold text-[#00191d] transition-colors ${
                    canSend ? "bg-accent hover:bg-[#5eeaf6]" : "bg-accent/25 cursor-default"
                  }`}
                >
                  Send →
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
