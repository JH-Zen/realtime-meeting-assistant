import { beforeEach, describe, expect, it } from "vitest";
import { ROOT, type GraphOperation } from "@rcc/shared";
import { MAX_BENCH_NODES, buildBenchOperations, parseBenchCount } from "../src/dev/benchSeed";
import { useGraphStore } from "../src/state/graphStore";

/**
 * The bench seed is only useful if it produces the thing it claims to measure: N nodes that the
 * reducer accepts and the layout places. A silently skipped operation would shrink the graph under
 * test and make the whole measurement lie, so that is what these assert — not the shape of the tree.
 */

const addedIds = (ops: GraphOperation[]) => ops.map((op) => (op.type === "add_node" ? op.node.id : "")).filter(Boolean);

describe("bench seed", () => {
  beforeEach(() => {
    useGraphStore.getState().reset();
  });

  it("reads the query param and refuses anything that is not a positive node count", () => {
    expect(parseBenchCount("?bench=500")).toBe(500);
    expect(parseBenchCount("?other=1&bench=40&x=2")).toBe(40);
    expect(parseBenchCount("")).toBe(0);
    expect(parseBenchCount("?bench=")).toBe(0);
    expect(parseBenchCount("?bench=abc")).toBe(0);
    expect(parseBenchCount("?bench=0")).toBe(0);
    expect(parseBenchCount("?bench=-7")).toBe(0);
    expect(parseBenchCount("?bench=1e99")).toBe(MAX_BENCH_NODES);
    expect(parseBenchCount(`?bench=${MAX_BENCH_NODES + 1}`)).toBe(MAX_BENCH_NODES);
  });

  it("builds the requested count deterministically", () => {
    const first = buildBenchOperations(120);
    const second = buildBenchOperations(120);

    expect(first).toHaveLength(120);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    expect(new Set(addedIds(first)).size).toBe(120);
    expect(new Set(first.map((op) => op.opId)).size).toBe(120);
  });

  it("orders every parent before its child and keeps the forest bounded", () => {
    const ops = buildBenchOperations(400);
    const placed = new Set<string>();
    const depth = new Map<string, number>();

    for (const op of ops) {
      if (op.type !== "add_node") throw new Error(`unexpected op ${op.type}`);
      const parent = op.node.parentId;
      if (parent !== undefined) {
        expect(placed.has(parent), `${op.node.id} points at a node added later`).toBe(true);
        depth.set(op.node.id, (depth.get(parent) ?? 0) + 1);
      } else {
        depth.set(op.node.id, 0);
      }
      placed.add(op.node.id);
    }

    expect(Math.max(...[...depth.values()])).toBeLessThanOrEqual(4);
    expect(ops.slice(0, 6).every((op) => op.type === "add_node" && op.node.parentId === undefined)).toBe(true);
  });

  it("lands all N nodes in the store and the layout, with no skipped operations", () => {
    const ops = buildBenchOperations(500);
    useGraphStore.getState().applyOps(ops);
    const state = useGraphStore.getState();

    expect(state.staleOpIds).toEqual([]);
    expect(Object.keys(state.graph.nodes)).toHaveLength(500);
    // Every node gets a coordinate, which is the assertion that the seeded map is really on screen.
    expect(Object.keys(state.positions)).toHaveLength(500);
    expect(state.graph.childOrder[ROOT]).toHaveLength(6);
  });

  it("is inert when replayed, so growing the map cannot double-count", () => {
    const ops = buildBenchOperations(80);
    useGraphStore.getState().applyOps(ops);
    useGraphStore.getState().applyOps(ops);
    useGraphStore.getState().applyOps(buildBenchOperations(120));

    const state = useGraphStore.getState();
    expect(Object.keys(state.graph.nodes)).toHaveLength(120);
    expect(state.staleOpIds).toEqual([]);
  });
});
