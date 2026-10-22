import { describe, expect, it } from "vitest";
import {
  applyOperation,
  applyOperations,
  createGraphState,
  isDescendantOrSelf,
  toNodeList,
  type GraphOperation,
  type MindMapNode,
} from "../src/index.js";

function node(id: string, title: string, parentId?: string): MindMapNode {
  return {
    id,
    title,
    ...(parentId ? { parentId } : {}),
    sourceTranscriptIds: [`${id}-t`],
    createdAt: 1,
    updatedAt: 1,
  };
}

function add(id: string, opId: string, parentId?: string): GraphOperation {
  return { type: "add_node", opId, node: node(id, `标题-${id}`, parentId) };
}

describe("graph reducer", () => {
  it("adds a root and a child, keeping sibling order stable", () => {
    const { state } = applyOperations(createGraphState(), [add("a", "1"), add("b", "2", "a"), add("c", "3", "a")]);
    expect(state.childOrder[""]).toEqual(["a"]);
    expect(state.childOrder.a).toEqual(["b", "c"]);
    expect(toNodeList(state).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the previous state, so React can diff by identity", () => {
    const before = createGraphState();
    const after = applyOperation(before, add("a", "1")).state;
    expect(before.nodes).toEqual({});
    expect(after.nodes).not.toBe(before.nodes);
  });

  it("ignores an operation whose opId was already applied", () => {
    const once = applyOperation(createGraphState(), add("a", "dup")).state;
    const twice = applyOperation(once, add("a", "dup"));
    expect(twice.skipped).toEqual(["dup"]);
    expect(Object.keys(twice.state.nodes)).toEqual(["a"]);
  });

  it("patches only the fields the operation carries", () => {
    const start = applyOperation(createGraphState(), add("a", "1")).state;
    const result = applyOperation(start, {
      type: "update_node",
      opId: "2",
      nodeId: "a",
      patch: { summary: "环境动态的内部模拟" },
      stampedAt: 500,
    });
    const updated = result.state.nodes.a;
    expect(updated?.summary).toBe("环境动态的内部模拟");
    expect(updated?.title).toBe("标题-a");
    expect(updated?.updatedAt).toBe(500);
  });

  it("merges by unioning sources and re-parenting children", () => {
    let state = applyOperations(createGraphState(), [
      add("wm", "1"),
      add("worldmodel", "2", undefined),
      add("child", "3", "worldmodel"),
    ]).state;
    state = applyOperation(state, {
      type: "merge_node",
      opId: "4",
      sourceNodeId: "worldmodel",
      targetNodeId: "wm",
      stampedAt: 700,
    }).state;

    expect(state.nodes.worldmodel).toBeUndefined();
    expect(state.nodes.wm?.sourceTranscriptIds).toEqual(["wm-t", "worldmodel-t"]);
    expect(state.nodes.child?.parentId).toBe("wm");
    expect(state.childOrder.wm).toEqual(["child"]);
  });

  /**
   * Merging `a` into `c`, a node below it, re-parents `a`'s children onto `c` — under their own
   * descendant. The branch then has no path from any root, so it vanishes from the rendered map while
   * still sitting in the store. The reducer has to hold this line itself: a replayed snapshot and a
   * second client both reach it without the gate having seen the operation.
   */
  it("refuses a merge that would bury a branch under its own descendant", () => {
    const start = applyOperations(createGraphState(), [add("a", "1"), add("b", "2", "a"), add("c", "3", "b")]).state;
    const result = applyOperation(start, {
      type: "merge_node",
      opId: "4",
      sourceNodeId: "a",
      targetNodeId: "c",
      stampedAt: 700,
    });

    expect(result.skipped).toEqual(["4"]);
    expect(toNodeList(result.state).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(result.state.nodes.b?.parentId).toBe("a");
    expect(result.state.nodes.c?.parentId).toBe("b");
    expect(result.state.childOrder.c ?? []).toEqual([]);
    expect(isDescendantOrSelf(result.state, "c", "a")).toBe(true);
  });

  it("keeps the subtree when a node is deleted", () => {
    let state = applyOperations(createGraphState(), [add("a", "1"), add("b", "2", "a"), add("c", "3", "b")]).state;
    state = applyOperation(state, { type: "delete_node", opId: "4", nodeId: "b" }).state;

    expect(state.nodes.b).toBeUndefined();
    expect(state.nodes.c?.parentId).toBe("a");
    expect(state.childOrder.a).toEqual(["c"]);
  });

  it("refuses a move that would make a node its own descendant", () => {
    const state = applyOperations(createGraphState(), [add("a", "1"), add("b", "2", "a")]).state;
    const result = applyOperation(state, { type: "move_node", opId: "3", nodeId: "a", parentId: "b", stampedAt: 800 });
    expect(result.skipped).toEqual(["3"]);
    expect(result.state.nodes.a?.parentId).toBeUndefined();
    expect(isDescendantOrSelf(result.state, "b", "a")).toBe(true);
  });

  it("skips operations that reference nodes the local state never saw", () => {
    const result = applyOperation(createGraphState(), {
      type: "update_node",
      opId: "1",
      nodeId: "ghost",
      patch: { title: "x" },
      stampedAt: 1,
    });
    expect(result.skipped).toEqual(["1"]);
    expect(result.touched).toEqual([]);
  });

  it("drops edges that touch a deleted node", () => {
    let state = applyOperations(createGraphState(), [add("a", "1"), add("b", "2")]).state;
    state = applyOperation(state, {
      type: "add_edge",
      opId: "3",
      edge: { id: "e1", source: "a", target: "b", relation: "相关" },
    }).state;
    expect(state.edges.e1).toBeDefined();

    state = applyOperation(state, { type: "delete_node", opId: "4", nodeId: "a" }).state;
    expect(state.edges.e1).toBeUndefined();
  });

  it("keeps an empty graph empty rather than inventing a root", () => {
    const { state } = applyOperations(createGraphState(), []);
    expect(toNodeList(state)).toEqual([]);
  });
});
