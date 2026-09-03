export default function DesignCanvas() {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">Analytics Dashboard</div>
        <div className="text-xs text-muted">85% · Artboard locked to viewport</div>
      </div>
      <div className="bg-panel2 border border-accent/40 rounded-lg p-5 max-w-2xl">
        <div className="text-base font-semibold mb-1">Telemetry Analytics</div>
        <div className="text-xs text-muted mb-4">
          Realtime monitoring and system metrics dashboard wireframe.
        </div>
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { label: "TOTAL SESSIONS", value: "184,204" },
            { label: "ACTIVE INSTANCES", value: "12" },
            { label: "ERRORS LOGGED", value: "0.04%" },
          ].map((k) => (
            <div key={k.label} className="bg-panel border border-border rounded-md p-3">
              <div className="text-[10px] text-muted">{k.label}</div>
              <div className="text-lg font-semibold">{k.value}</div>
            </div>
          ))}
        </div>
        <div className="bg-panel border border-border rounded-md p-4 h-32 flex items-center justify-center text-xs text-muted">
          Resource Consumption (Cores / Threads) — chart placeholder
        </div>
      </div>
    </div>
  );
}
