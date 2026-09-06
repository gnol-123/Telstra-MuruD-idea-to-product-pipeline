"use client";

import { useState } from "react";
import { AgentNode } from "@/lib/types";
import { sendChat, streamChat } from "@/lib/api";

interface LocalMessage {
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
}

export default function Inspector({ node }: { node: AgentNode | null }) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [useStream, setUseStream] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!node) {
    return (
      <aside className="w-80 shrink-0 border-l border-border p-5 text-sm text-muted">
        Select a node to chat with it.
      </aside>
    );
  }

  async function handleSend() {
    if (!draft.trim() || busy) return;
    const prompt = draft;
    setDraft("");
    setMessages((m) => [...m, { role: "user", content: prompt }]);
    setBusy(true);
    const clientToken = crypto.randomUUID();

    if (!useStream) {
      try {
        const res = await sendChat(node!.id, prompt, clientToken);
        setMessages((m) => [
          ...m,
          { role: "assistant", content: res.assistant_message.content },
        ]);
      } catch (e: any) {
        setMessages((m) => [...m, { role: "assistant", content: `⚠ ${e.message}` }]);
      } finally {
        setBusy(false);
      }
      return;
    }

    // Streaming path: append one growing assistant message as chunks arrive.
    setMessages((m) => [...m, { role: "assistant", content: "", pending: true }]);
    try {
      await streamChat(node!.id, prompt, clientToken, {
        onChunk: (text) => {
          setMessages((m) => {
            const copy = [...m];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { ...last, content: last.content + text };
            return copy;
          });
        },
        onDone: () => {
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { ...copy[copy.length - 1], pending: false };
            return copy;
          });
        },
        onError: (data) => {
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = {
              role: "assistant",
              content: `⚠ ${data?.message ?? "stream error"}`,
            };
            return copy;
          });
        },
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="w-80 shrink-0 border-l border-border flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border">
        <div className="text-sm font-medium">{node.name}</div>
        <div className="text-[10px] text-muted">{node.agent_slug}</div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-xs text-muted">
            No history
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-[240px] text-xs px-3 py-2 rounded-lg text-left ${
                m.role === "user"
                  ? "bg-accent/10 border border-accent/30"
                  : "bg-panel2 border border-border"
              }`}
            >
              {m.content || (m.pending ? "…" : "")}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-3 space-y-2">
        <label className="flex items-center gap-2 text-[10px] text-muted">
          <input
            type="checkbox"
            checked={useStream}
            onChange={(e) => setUseStream(e.target.checked)}
            className="accent-accent"
          />
          Stream response (chat/stream)
        </label>
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Message this agent…"
            className="flex-1 bg-panel2 border border-border rounded-md px-3 py-2 text-xs outline-none focus:border-accent/50"
          />
          <button
            onClick={handleSend}
            disabled={busy}
            className="bg-accent/15 text-accent border border-accent/40 rounded-md px-3 py-2 text-xs disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}
