"use client";

import { useEffect, useReducer, useRef } from "react";
import { AgentNode, Edge } from "@/lib/types";

// A frontend-only progress strip for a mesh run. Nothing here comes from the
// backend: it watches which agents are working (a chat turn in flight here,
// or node.status === "running" from the poll) and counts them off as they
// finish.
//
// A run starts when the first agent starts working and ends once nothing
// has been working for GRACE_MS (the poll ticks every 2s, so an orchestrator
// handing off between agents can briefly look idle). Its scope is every
// agent that has worked during it plus everything downstream of those over
// context links — the agents the work is expected to reach.

const GRACE_MS = 3000;
const LINGER_MS = 4500;

interface Run {
  started: Set<string>;
  finished: Set<string>;
  failed: Set<string>;
  idleSince: number | null;
}

export default function RunProgress({
  agents,
  workingIds,
  edges,
}: {
  agents: AgentNode[];
  workingIds: string[];
  edges: Edge[];
}) {
  const runRef = useRef<Run | null>(null);
  const prevWorking = useRef<Set<string>>(new Set());
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const workingKey = [...workingIds].sort().join(",");
  const statusOf = (id: string) => agents.find((a) => a.id === id)?.status;

  useEffect(() => {
    const now = new Set(workingIds);
    const prev = prevWorking.current;
    let run = runRef.current;

    if (now.size > 0) {
      const resumable = run && (run.idleSince === null || Date.now() - run.idleSince < GRACE_MS);
      if (!run || !resumable) run = { started: new Set(), finished: new Set(), failed: new Set(), idleSince: null };
      run.idleSince = null;
      for (const id of now) {
        run.started.add(id);
        run.finished.delete(id);
        run.failed.delete(id);
      }
    }
    if (run) {
      for (const id of prev) {
        if (now.has(id)) continue;
        (statusOf(id) === "error" ? run.failed : run.finished).add(id);
      }
      if (now.size === 0 && run.idleSince === null) run.idleSince = Date.now();
    }

    runRef.current = run;
    prevWorking.current = now;
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingKey]);

  // Once idle: flip to "finished" after the grace period, then clear.
  const idleSince = runRef.current?.idleSince ?? null;
  useEffect(() => {
    if (idleSince === null) return;
    const wait = Math.max(0, idleSince + GRACE_MS - Date.now());
    const done = setTimeout(rerender, wait);
    const clear = setTimeout(() => {
      if (runRef.current?.idleSince === idleSince) {
        runRef.current = null;
        rerender();
      }
    }, wait + LINGER_MS);
    return () => {
      clearTimeout(done);
      clearTimeout(clear);
    };
  }, [idleSince]);

  const run = runRef.current;
  if (!run) return null;

  // Scope: agents that worked, plus everything downstream of them.
  const alive = new Set(agents.map((a) => a.id));
  const scope = new Set([...run.started].filter((id) => alive.has(id)));
  const queue = [...scope];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges) {
      if (e.kind === "context" && e.source_node_id === id && alive.has(e.target_node_id) && !scope.has(e.target_node_id)) {
        scope.add(e.target_node_id);
        queue.push(e.target_node_id);
      }
    }
  }
  const total = Math.max(scope.size, 1);
  const done = [...scope].filter((id) => run.finished.has(id) || run.failed.has(id)).length;
  const failed = [...scope].filter((id) => run.failed.has(id)).length;

  const finishedRun = run.idleSince !== null && Date.now() - run.idleSince >= GRACE_MS;
  const working = agents.filter((a) => workingIds.includes(a.id));
  const fraction = finishedRun ? done / total : Math.max(done / total, 0.04);

  // The orchestrator sits behind almost every turn, so it's working nearly
  // the whole run — leading with its name would make the bar say "Running
  // Orchestrator" throughout. Lead with whichever other agent most recently
  // started instead (run.started keeps insertion order) and fold the
  // orchestrator into "+N more" like anyone else. Only lead with the
  // orchestrator when it's the only one currently working.
  const workingIdSet = new Set(workingIds);
  const activeInStartOrder = [...run.started].filter((id) => workingIdSet.has(id));
  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const nonOrchestratorActive = activeInStartOrder.filter((id) => agentOf(id)?.agent_slug !== "orchestrator");
  const leadId = (nonOrchestratorActive.length ? nonOrchestratorActive : activeInStartOrder).at(-1);
  const lead = (leadId ? agentOf(leadId) : undefined) ?? working[0];

  const label = finishedRun
    ? "Run finished"
    : working.length === 0
    ? "Wrapping up…"
    : `Running ${lead?.name ?? "agent"}${working.length > 1 ? ` + ${working.length - 1} more` : ""}`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex-none flex items-center justify-center gap-3.5 h-[38px] px-5 border-b border-white/[0.08] bg-primary/[0.07] anim-fadein"
    >
      {finishedRun ? (
        <span className="w-4 h-4 grid place-items-center rounded-full bg-green/15 text-green text-[10px] leading-none">✓</span>
      ) : (
        <span className="w-3.5 h-3.5 rounded-full border-2 border-accent/25 border-t-accent animate-spin" />
      )}
      <span
        className={`text-[12.5px] font-semibold whitespace-nowrap max-w-[320px] truncate ${
          finishedRun ? "text-green" : "text-accent"
        }`}
      >
        {label}
      </span>

      <div
        className="relative flex-1 max-w-[760px] h-[4px] rounded-full bg-white/[0.08] overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label="Agents finished in this run"
      >
        <div
          className={`relative h-full rounded-full overflow-hidden transition-[width] duration-700 ease-out ${
            finishedRun ? "bg-green/80" : "bg-gradient-to-r from-primary to-accent"
          }`}
          style={{ width: `${fraction * 100}%` }}
        >
          {!finishedRun && (
            <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent anim-sheen" />
          )}
        </div>
      </div>

      <span className="text-[11px] text-white/45 whitespace-nowrap tabular-nums">
        {done} of {total} agent{total === 1 ? "" : "s"} done
        {failed > 0 && <span className="text-red-300"> · {failed} failed</span>}
      </span>
    </div>
  );
}
