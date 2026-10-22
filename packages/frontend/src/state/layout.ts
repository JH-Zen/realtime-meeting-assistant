import { hierarchy, tree } from "d3-hierarchy";
import { ROOT, type GraphState, type MindMapNode } from "@rcc/shared";

export interface Placement {
  x: number;
  y: number;
}

export const NODE_W = 172;
/**
 * The row height the layout reserves per node, and the contract `.mind-node` in `styles.css` keeps:
 * that rule fixes the box to the same number and clamps its text so nothing can grow past it. It was
 * 40 while the painted box measured 72 (one-line title) and 87 (two-line), which made neighbouring
 * rows overlap by construction.
 */
export const NODE_H = 88;
const COLUMN_GAP = 64;
const ROW_GAP = 14;
const ROOT_GAP = 26;

interface Branch {
  id: string;
  children: Branch[];
}

/**
 * Each top-level tree is anchored and never moved by a later insertion; only the inside of the
 * touched tree re-balances, and a dragged node wins over both. That is what keeps the graph from
 * jumping wholesale every time the model adds a leaf (§43).
 */
export function layoutGraph(
  state: GraphState,
  known: Record<string, Placement>,
  pinned: Record<string, Placement>,
  collapsed: Record<string, boolean>,
): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  // The y below which the next tree's box may start. A tidy layout centres siblings on their parent,
  // so a tree reaches above its root as well as below: anchoring the next root at the previous
  // bottom — which is what this loop used to do — stacks the two boxes on top of each other.
  let nextTop = 0;

  for (const rootId of state.childOrder[ROOT] ?? []) {
    const tidy = tidyAround(rootId, state, collapsed);
    let minOffset = 0;
    let maxOffset = 0;
    for (const offset of tidy.values()) {
      if (offset.y < minOffset) minOffset = offset.y;
      if (offset.y > maxOffset) maxOffset = offset.y;
    }
    const anchor = pinned[rootId] ?? known[rootId] ?? { x: 0, y: nextTop - minOffset };
    for (const [id, offset] of tidy) {
      const fixed = pinned[id];
      out[id] = fixed ?? { x: anchor.x + offset.x, y: anchor.y + offset.y };
    }
    nextTop = Math.max(nextTop, anchor.y + maxOffset + NODE_H) + ROW_GAP + ROOT_GAP;
  }

  return out;
}

/** Tidy coordinates relative to the subtree root at (0, 0). Collapsed branches are omitted. */
function tidyAround(rootId: string, state: GraphState, collapsed: Record<string, boolean>): Map<string, Placement> {
  const branch = (id: string): Branch => ({
    id,
    children: collapsed[id] ? [] : (state.childOrder[id] ?? []).map(branch),
  });

  const layout = tree<Branch>().nodeSize([NODE_H + ROW_GAP, NODE_W + COLUMN_GAP]);
  const rootNode = layout(hierarchy(branch(rootId), (data) => data.children));

  const out = new Map<string, Placement>();
  for (const item of rootNode.descendants()) {
    if (item.data === undefined) continue;
    out.set(item.data.id, { x: item.y ?? 0, y: item.x ?? 0 });
  }
  return out;
}

/** Nodes hidden by a collapsed ancestor are neither laid out nor rendered. */
export function visibleNodes(state: GraphState, collapsed: Record<string, boolean>): MindMapNode[] {
  const out: MindMapNode[] = [];
  const visit = (key: string, hidden: boolean) => {
    for (const id of state.childOrder[key] ?? []) {
      const node = state.nodes[id];
      if (!node) continue;
      if (!hidden) out.push(node);
      visit(id, hidden || collapsed[id] === true);
    }
  };
  visit(ROOT, false);
  return out;
}
