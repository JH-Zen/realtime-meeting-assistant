import { describe, expect, it } from "vitest";
import { applyOperations, createGraphState, type GraphOperation, type MindMapNode } from "@rcc/shared";
import { NODE_H, layoutGraph } from "../src/state/layout";

/**
 * The invariant Test B is really about: a top-level tree is anchored below the one before it, never
 * on top of it. Nothing else in the suite checked this — the graph-state tests only assert that an
 * existing tree does not move, so a layout that stacks trees inside each other still passes.
 */

function add(id: string, parentId?: string): GraphOperation {
  const node: MindMapNode = {
    id,
    title: id,
    parentId,
    sourceTranscriptIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
  return { type: "add_node", opId: `op-${id}`, node };
}

function place(
  ...ops: GraphOperation[]
): Record<string, { x: number; y: number }> {
  return layoutGraph(applyOperations(createGraphState(), ops).state, {}, {}, {});
}

/** A tree is tall through its siblings: a horizontal tidy layout puts a chain on one row. */
function wideTree(root: string, rows: number): GraphOperation[] {
  const ops: GraphOperation[] = [add(root)];
  for (let index = 0; index < rows; index++) ops.push(add(`${root}-${index}`, root));
  return ops;
}

function verticalSpan(placed: Record<string, { x: number; y: number }>, prefix: string): [number, number] {
  const ys = Object.entries(placed)
    .filter(([id]) => id.startsWith(prefix))
    .map(([, point]) => point.y);
  return [Math.min(...ys), Math.max(...ys)];
}

function rowAt(placed: Record<string, { x: number; y: number }>, id: string): number {
  const point = placed[id];
  if (!point) throw new Error(`${id} was never placed`);
  return point.y;
}

describe("frontend layout", () => {
  it("anchors every top-level tree below the one before it", () => {
    const placed = place(...wideTree("a", 5), ...wideTree("b", 5), ...wideTree("c", 5));

    for (const [first, second] of [
      ["a", "b"],
      ["b", "c"],
    ] as const) {
      const [, bottom] = verticalSpan(placed, `${first}-`);
      const [top] = verticalSpan(placed, `${second}-`);
      expect(top).toBeGreaterThan(bottom + NODE_H);
      expect(rowAt(placed, second)).toBeGreaterThan(bottom + NODE_H);
    }
  });

  it("sizes each anchor gap to the height of the tree above it", () => {
    const skinny = place(...wideTree("a", 1), ...wideTree("b", 1));
    const tall = place(...wideTree("a", 8), ...wideTree("b", 1));

    // Seven extra sibling rows spread ≈190 px around the root; one row adds nothing.
    expect(rowAt(tall, "b") - rowAt(skinny, "b")).toBeGreaterThan(3 * NODE_H);
  });

  it("lets a dragged root win and still clears the trees under it", () => {
    const state = applyOperations(createGraphState(), [...wideTree("a", 3), ...wideTree("b", 3)]).state;
    const placed = layoutGraph(state, {}, { a: { x: 0, y: 900 } }, {});

    expect(placed.a).toEqual({ x: 0, y: 900 });
    const [, bottom] = verticalSpan(placed, "a-");
    expect(rowAt(placed, "b")).toBeGreaterThan(bottom + NODE_H);
  });
});
