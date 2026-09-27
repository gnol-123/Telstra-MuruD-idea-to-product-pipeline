// Canvas "Tidy": a left-to-right flow layout for the agent graph.
//
// Only cards that actually render on the canvas are placed. Tools and
// environments equipped on an agent draw as chips on that agent's card, so
// they have no box of their own and are left alone (placing them is what
// used to scatter the grid with invisible gaps).
//
// Agents are laid out by their context links: each column is one step
// further downstream (longest path from a source), and within a column
// cards are ordered by where their upstream cards sit, so links mostly run
// straight across instead of crossing. Separate chains stack vertically,
// unlinked agents follow in a row, then any loose tool/environment cards.

import { Edge, ProjectNode, isAgentNode } from "./types";

export const TIDY_ORIGIN = { x: 80, y: 70 };
const COL = 360; // card width (240) + gutter for the link pill
const ROW = 240; // tallest collapsed agent card + breathing room
const BLOCK_GAP = 60; // extra space between separate chains
const ROW_WRAP = 5; // cards per row for unlinked agents / loose nodes

type Pos = { x: number; y: number };

export function tidyLayout(visible: ProjectNode[], edges: Edge[]): Map<string, Pos> {
  const out = new Map<string, Pos>();
  const agents = visible.filter(isAgentNode);
  const loose = visible.filter((n) => !isAgentNode(n));
  const agentIds = new Set(agents.map((a) => a.id));

  // Current reading order (top-to-bottom, then left-to-right) is the
  // tie-breaker everywhere, so Tidy keeps the user's rough arrangement.
  const readingOrder = new Map(
    [...agents]
      .sort((a, b) => (a.position_y ?? 0) - (b.position_y ?? 0) || (a.position_x ?? 0) - (b.position_x ?? 0))
      .map((a, i) => [a.id, i])
  );

  const links = edges.filter(
    (e) =>
      e.kind === "context" &&
      e.source_node_id !== e.target_node_id &&
      agentIds.has(e.source_node_id) &&
      agentIds.has(e.target_node_id)
  );
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const id of agentIds) {
    parents.set(id, []);
    children.set(id, []);
  }
  for (const e of links) {
    parents.get(e.target_node_id)!.push(e.source_node_id);
    children.get(e.source_node_id)!.push(e.target_node_id);
  }

  // Weakly connected components, in reading order of their first card.
  const seen = new Set<string>();
  const components: string[][] = [];
  const isolated: string[] = [];
  for (const a of [...agents].sort((x, y) => readingOrder.get(x.id)! - readingOrder.get(y.id)!)) {
    if (seen.has(a.id)) continue;
    const comp: string[] = [];
    const stack = [a.id];
    seen.add(a.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const n of [...parents.get(id)!, ...children.get(id)!]) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    if (comp.length === 1) isolated.push(a.id);
    else components.push(comp);
  }

  let top = TIDY_ORIGIN.y;

  for (const comp of components) {
    const layers = layerComponent(comp, parents, children, readingOrder);
    layers.forEach((col, c) =>
      col.forEach((id, r) => out.set(id, { x: TIDY_ORIGIN.x + c * COL, y: top + r * ROW }))
    );
    const tallest = Math.max(...layers.map((l) => l.length));
    top += tallest * ROW + BLOCK_GAP;
  }

  top = placeRows(isolated, top, out);
  if (isolated.length && loose.length) top += BLOCK_GAP;

  const looseOrdered = [...loose].sort(
    (a, b) => (a.position_y ?? 0) - (b.position_y ?? 0) || (a.position_x ?? 0) - (b.position_x ?? 0)
  );
  placeRows(
    looseOrdered.map((n) => n.id),
    top,
    out
  );

  return out;
}

function placeRows(ids: string[], top: number, out: Map<string, Pos>): number {
  ids.forEach((id, i) =>
    out.set(id, {
      x: TIDY_ORIGIN.x + (i % ROW_WRAP) * COL,
      y: top + Math.floor(i / ROW_WRAP) * ROW,
    })
  );
  return ids.length ? top + Math.ceil(ids.length / ROW_WRAP) * ROW : top;
}

// Columns for one connected chain. Longest-path layering (Kahn's order), so
// a card always sits right of everything feeding it. Cycles can't be fully
// ordered; whatever is left is placed one column past its placed parents.
function layerComponent(
  comp: string[],
  parents: Map<string, string[]>,
  children: Map<string, string[]>,
  readingOrder: Map<string, number>
): string[][] {
  const inComp = new Set(comp);
  const indeg = new Map(comp.map((id) => [id, parents.get(id)!.filter((p) => inComp.has(p)).length]));
  const depth = new Map<string, number>();
  const queue = comp.filter((id) => indeg.get(id) === 0).sort((a, b) => readingOrder.get(a)! - readingOrder.get(b)!);
  for (const id of queue) depth.set(id, 0);

  while (queue.length) {
    const id = queue.shift()!;
    for (const c of children.get(id)!) {
      if (!inComp.has(c)) continue;
      depth.set(c, Math.max(depth.get(c) ?? 0, depth.get(id)! + 1));
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }

  // Cycle members: settle them in reading order after their known parents.
  const rest = comp.filter((id) => !depth.has(id)).sort((a, b) => readingOrder.get(a)! - readingOrder.get(b)!);
  for (const id of rest) {
    const known = parents.get(id)!.filter((p) => depth.has(p)).map((p) => depth.get(p)!);
    depth.set(id, known.length ? Math.max(...known) + 1 : 0);
  }

  const layers: string[][] = [];
  for (const id of comp) {
    const d = depth.get(id)!;
    if (!layers[d]) layers[d] = [];
    layers[d].push(id);
  }
  for (let i = 0; i < layers.length; i++) if (!layers[i]) layers[i] = [];
  layers.forEach((l) => l.sort((a, b) => readingOrder.get(a)! - readingOrder.get(b)!));

  // Two sweeps of barycenter ordering: sort each column by the mean row of
  // its upstream cards, so a chain's links run as straight as possible.
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 1; c < layers.length; c++) {
      const prevRow = new Map(layers[c - 1].map((id, r) => [id, r]));
      const score = (id: string) => {
        const rows = parents.get(id)!.filter((p) => prevRow.has(p)).map((p) => prevRow.get(p)!);
        return rows.length ? rows.reduce((s, r) => s + r, 0) / rows.length : Number.POSITIVE_INFINITY;
      };
      const current = new Map(layers[c].map((id, r) => [id, r]));
      layers[c].sort((a, b) => {
        const sa = score(a);
        const sb = score(b);
        if (sa !== sb) return sa === Infinity ? 1 : sb === Infinity ? -1 : sa - sb;
        return current.get(a)! - current.get(b)!;
      });
    }
  }

  return layers.filter((l) => l.length > 0);
}
