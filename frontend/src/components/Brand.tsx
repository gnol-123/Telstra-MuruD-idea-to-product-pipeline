// The Agent Mesh mark from the UX mockup: a rotated square inside a rounded
// square, both in the accent blue.
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <div
      className="border-[1.5px] border-accent rounded-[9px] grid place-items-center flex-none"
      style={{ width: size, height: size }}
    >
      <div
        className="border-[1.5px] border-accent rounded-[4px] rotate-45"
        style={{ width: size * 0.44, height: size * 0.44 }}
      />
    </div>
  );
}

export function Brand({ sub }: { sub?: string }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <BrandMark />
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-[-0.01em]">Agent Mesh</div>
        <div className="text-[10.5px] text-white/[0.38] truncate">{sub ?? "Telstra Muru-D Team 2"}</div>
      </div>
    </div>
  );
}
