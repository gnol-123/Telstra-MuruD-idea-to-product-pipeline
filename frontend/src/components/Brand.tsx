// Telstra muru-D logo.
export function BrandMark({ size = 32 }: { size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/murud-logo.svg" alt="muru-D" className="flex-none object-contain" style={{ width: size, height: size }} />;
}

// muru-D × RMIT lockup for headers.
export function BrandLockup() {
  /* eslint-disable @next/next/no-img-element */
  return (
    <div className="flex items-center gap-2.5 flex-none">
      <img src="/murud-logo.svg" alt="muru-D" className="h-11 w-auto" />
      <span className="text-white/40 text-sm">×</span>
      <img src="/rmit-logo.svg" alt="RMIT University" className="h-7 w-auto" />
    </div>
  );
  /* eslint-enable @next/next/no-img-element */
}

export function Brand({ sub }: { sub?: string }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <BrandLockup />
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-[-0.01em]">Spindle</div>
        <div className="text-[10.5px] text-white/[0.38] truncate">{sub ?? "Telstra Muru-D Team 2"}</div>
      </div>
    </div>
  );
}
