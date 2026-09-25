"use client";

import { useEffect, useState } from "react";
import { EnvironmentPort } from "@/lib/types";
import { ToolbarBtn } from "./CodeView";

export type Device = "desktop" | "tablet" | "phone";

const DEVICE_WIDTH: Record<Device, number | null> = { desktop: null, tablet: 820, phone: 390 };
const DEVICE_LABEL: Record<Device, string> = { desktop: "Desktop", tablet: "Tablet", phone: "Phone" };

// Ports agents are told to use, in the order worth showing first.
const PREFERRED = [3000, 5173, 8080, 8000, 4173, 4200, 5000];

export function pickDefaultPort(ports: EnvironmentPort[]): number | null {
  if (ports.length === 0) return null;
  for (const p of PREFERRED) if (ports.some((x) => x.port === p)) return p;
  return ports[0].port;
}

export default function PreviewPane({
  ports,
  portsLoaded,
  activePort,
  path,
  reloadKey,
  device,
  autoReload,
  serveLabel,
  serving,
  compact,
  onSelectPort,
  onNavigate,
  onReload,
  onDevice,
  onAutoReload,
  onServe,
  onOpenPort,
}: {
  ports: EnvironmentPort[];
  portsLoaded: boolean;
  activePort: number | null;
  path: string;
  reloadKey: number;
  device: Device;
  autoReload: boolean;
  // What "Serve" would serve, e.g. "Coding Agent" — shown in the empty state.
  serveLabel: string;
  serving: boolean;
  // Split view: tighter toolbar.
  compact: boolean;
  onSelectPort: (port: number) => void;
  onNavigate: (path: string) => void;
  onReload: () => void;
  onDevice: (d: Device) => void;
  onAutoReload: (on: boolean) => void;
  onServe: () => void;
  onOpenPort: (port: number) => void;
}) {
  const port = ports.find((p) => p.port === activePort) ?? null;
  const [addr, setAddr] = useState(path);
  const [loading, setLoading] = useState(true);
  const [manualPort, setManualPort] = useState("");
  const width = DEVICE_WIDTH[device];

  useEffect(() => setAddr(path), [path]);
  useEffect(() => setLoading(true), [reloadKey, activePort, path]);

  const src = port ? `${port.url}${path.startsWith("/") ? path : `/${path}`}` : null;

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#05080a]">
      {/* toolbar */}
      <div className="flex-none flex items-center gap-2 px-2.5 h-[38px] border-b border-white/[0.07]">
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
          {ports.map((p) => {
            const on = p.port === activePort;
            return (
              <button
                key={p.port}
                onClick={() => onSelectPort(p.port)}
                title={`${p.command || "unknown process"}${p.local_only ? " — bound to localhost only" : ""}`}
                className={`flex-none flex items-center gap-1.5 px-2 py-[3px] rounded-[5px] border text-[10.5px] ${
                  on ? "border-green/50 bg-green/10 text-green" : "border-white/[0.12] text-white/55 hover:text-text"
                }`}
              >
                <span className={`w-[5px] h-[5px] rounded-full ${on ? "bg-green anim-softpulse" : "bg-green/60"}`} />
                <span className="font-mono">:{p.port}</span>
                {!compact && p.process && <span className="text-white/35 max-w-[120px] truncate">{p.process}</span>}
              </button>
            );
          })}
        </div>

        {port && (
          <form
            className="flex-1 min-w-[120px] flex items-center h-[26px] rounded-md border border-white/[0.1] bg-white/[0.03] focus-within:border-accent/40"
            onSubmit={(e) => {
              e.preventDefault();
              onNavigate(addr.startsWith("/") ? addr : `/${addr}`);
            }}
          >
            <span className="pl-2 text-[10.5px] text-white/30 font-mono whitespace-nowrap truncate max-w-[45%]" title={port.url}>
              {compact ? `:${port.port}` : port.url.replace(/^https:\/\//, "")}
            </span>
            <input
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              spellCheck={false}
              aria-label="Preview path"
              className="flex-1 min-w-0 bg-transparent outline-none px-0.5 text-[11px] font-mono text-text"
            />
          </form>
        )}

        {port && (
          <div className="flex-none flex items-center gap-1">
            <ToolbarBtn onClick={onReload} title="Reload the preview">⟳</ToolbarBtn>
            {!compact &&
              (Object.keys(DEVICE_WIDTH) as Device[]).map((d) => (
                <ToolbarBtn key={d} active={device === d} onClick={() => onDevice(d)} title={`${DEVICE_LABEL[d]} width`}>
                  {d === "desktop" ? "▭" : d === "tablet" ? "▯" : "▫"}
                </ToolbarBtn>
              ))}
            <ToolbarBtn
              active={autoReload}
              onClick={() => onAutoReload(!autoReload)}
              title="Reload automatically when files change"
            >
              {autoReload ? "● Live" : "○ Live"}
            </ToolbarBtn>
            <a
              href={src ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in a new tab"
              className="whitespace-nowrap text-[10.5px] px-2 py-[3px] rounded-[5px] border border-white/[0.12] text-white/60 hover:text-text hover:border-white/30"
            >
              ↗
            </a>
          </div>
        )}
      </div>

      {port?.local_only && (
        <div className="flex-none px-3 py-1.5 text-[10.5px] text-amber/90 bg-amber/[0.06] border-b border-amber/20">
          This server is listening on localhost only. If the preview can&apos;t connect, restart it bound to 0.0.0.0
          (e.g. <span className="font-mono">--host 0.0.0.0</span>).
        </div>
      )}

      {/* body */}
      <div className="relative flex-1 min-h-0 overflow-auto grid place-items-stretch">
        {port && src ? (
          <div className="h-full flex justify-center" style={{ padding: width ? "14px 14px 0" : 0 }}>
            <div
              className={`relative h-full bg-white ${width ? "rounded-t-xl overflow-hidden border border-white/[0.15] shadow-[0_20px_60px_rgba(0,0,0,.7)]" : ""}`}
              style={{ width: width ?? "100%", maxWidth: "100%" }}
            >
              {loading && <div className="absolute top-0 left-0 right-0 h-[2px] bg-accent/70 anim-softpulse z-10" />}
              <iframe
                key={`${reloadKey}:${src}`}
                src={src}
                title={`Preview of port ${port.port}`}
                onLoad={() => setLoading(false)}
                // Cross-origin already walls it off from the app; sandbox also
                // stops the page navigating the app's own tab.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                className="w-full h-full border-0 bg-white"
              />
            </div>
          </div>
        ) : (
          <div className="grid place-items-center p-8">
            <div className="max-w-[340px] text-center">
              <div className="mx-auto w-11 h-11 rounded-xl border border-white/[0.14] grid place-items-center text-white/40 text-lg">
                ▶
              </div>
              <div className="mt-3 text-[13px] text-white/80">
                {portsLoaded ? "Nothing is being served yet" : "Looking for running servers…"}
              </div>
              <div className="mt-1.5 text-[11.5px] text-white/40 leading-relaxed">
                When an agent starts a dev server, it shows up here on its own. You can also serve the files as a
                static site right now.
              </div>
              <button
                onClick={onServe}
                disabled={serving}
                className="mt-4 w-full bg-accent hover:bg-[#5eeaf6] text-[#00191d] rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-60"
              >
                {serving ? "Starting server…" : `▶ Serve ${serveLabel}`}
              </button>
              <form
                className="mt-2.5 flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = parseInt(manualPort, 10);
                  if (n >= 1 && n <= 65535) onOpenPort(n);
                }}
              >
                <input
                  value={manualPort}
                  onChange={(e) => setManualPort(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="or open a port, e.g. 3000"
                  inputMode="numeric"
                  className="flex-1 min-w-0 bg-white/[0.03] border border-white/[0.12] rounded-md px-2.5 py-1.5 text-[11px] outline-none focus:border-accent/50"
                />
                <button
                  type="submit"
                  disabled={!manualPort}
                  className="text-[11px] px-3 rounded-md border border-white/[0.14] text-white/60 hover:text-text disabled:opacity-40"
                >
                  Open
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
