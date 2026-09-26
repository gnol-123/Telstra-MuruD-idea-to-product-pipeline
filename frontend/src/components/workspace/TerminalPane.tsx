"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { environmentTerminalUrl } from "@/lib/api";

type State = "connecting" | "open" | "closed";

// Close codes from the terminal socket (see API.md), in words.
const CLOSE_REASONS: Record<number, string> = {
  4401: "Not signed in — log in again.",
  4403: "The terminal needs a secure (wss://) connection.",
  4404: "Environment not found.",
  4409: "The environment isn't running. Start it first.",
  4502: "The sandbox couldn't be reached.",
};

// A real terminal (xterm.js) on the environment's PTY socket. Mounted once
// and kept alive while hidden, so collapsing the panel doesn't kill a
// running dev server's shell. xterm touches `window` on import, so it is
// loaded lazily in the browser rather than at module scope.
export default function TerminalPane({
  projectId,
  nodeId,
  cwdHint,
  visible,
}: {
  projectId: string;
  nodeId: string;
  // Where to cd on connect — the agent folder the window opened on.
  cwdHint: string | null;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [reason, setReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 12,
        lineHeight: 1.25,
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: {
          background: "#080C1C",
          foreground: "#F5EDE2",
          cursor: "#5C8DFF",
          selectionBackground: "rgba(92,141,255,0.25)",
          cyan: "#5C8DFF",
          green: "#7ee787",
          yellow: "#F44E1A",
          brightBlack: "#5b6770",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        // Hidden on mount: no size yet. The resize observer fits it later.
      }
      termRef.current = term;
      fitRef.current = fit;

      let url: string;
      try {
        url = await environmentTerminalUrl(projectId, nodeId, term.cols, term.rows);
      } catch (e) {
        setState("closed");
        setReason(e instanceof Error ? e.message : "Could not connect");
        return;
      }
      if (disposed) return;

      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      const send = (frame: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(frame));

      ws.onopen = () => {
        setState("open");
        setReason(null);
        if (cwdHint) send({ type: "input", data: `cd ${JSON.stringify(cwdHint)} 2>/dev/null; clear\n` });
        term.focus();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const frame = JSON.parse(ev.data);
            if (frame.type === "exit") term.write(`\r\n\x1b[90m[shell exited with code ${frame.code}]\x1b[0m\r\n`);
          } catch {
            term.write(ev.data);
          }
        } else {
          term.write(new Uint8Array(ev.data));
        }
      };
      ws.onclose = (ev) => {
        setState("closed");
        setReason(CLOSE_REASONS[ev.code] ?? (ev.code === 1000 ? null : "Connection closed."));
      };
      term.onData((data) => send({ type: "input", data }));
      term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));

      observer = new ResizeObserver(() => {
        if (!hostRef.current || hostRef.current.offsetWidth === 0) return;
        try {
          fit.fit();
        } catch {
          // Mid-teardown; nothing to fit.
        }
      });
      observer.observe(hostRef.current);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      wsRef.current?.close();
      wsRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [projectId, nodeId, cwdHint, attempt]);

  // Becoming visible is a resize the observer may not see (display toggles).
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
        termRef.current?.focus();
      } catch {
        // Not ready yet.
      }
    }, 30);
    return () => clearTimeout(t);
  }, [visible]);

  return (
    <div className="relative h-full flex flex-col bg-[#080C1C]">
      <div ref={hostRef} className="terminal-host flex-1 min-h-0" />
      {state !== "open" && (
        <div className="absolute top-2 right-3 flex items-center gap-2 text-[10.5px]">
          <span className={state === "connecting" ? "text-white/40" : "text-amber/90"}>
            {state === "connecting" ? "Connecting…" : reason ?? "Disconnected"}
          </span>
          {state === "closed" && (
            <button
              onClick={() => {
                setState("connecting");
                setAttempt((a) => a + 1);
              }}
              className="px-2 py-[2px] rounded border border-accent/40 text-accent hover:bg-accent/10"
            >
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
