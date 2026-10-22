import { describe, expect, it } from "vitest";
import {
  createGraphState,
  parseGraphOperations,
  type GraphReadView,
} from "../src/index.js";

function view(overrides: Partial<GraphReadView> = {}): GraphReadView {
  const state = createGraphState();
  return {
    hasNode: (id) => state.nodes[id] !== undefined,
    isDescendantOrSelf: () => false,
    isOpSeen: () => false,
    ...overrides,
  };
}

const meta = { responseId: "resp-1", now: 1000 };

describe("parseGraphOperations", () => {
  it("clamps text the model wrote past what the map can show", () => {
    // Nothing enforces the prompt's "标题不超过 14 个字", and the node box is CSS-clamped to two
    // lines, so a full-sentence title is invisible to the reader but not to the model: `capNodes`
    // feeds the last 40 titles and summaries back into every flush prompt. The bounds here are what
    // keep that echo finite — and they are loose enough to leave every character that can be seen.
    const long = "世界模型可以预测下一个状态，因为它是生成式的。".repeat(10);
    const result = parseGraphOperations(
      {
        operations: [
          { type: "add_node", node: { id: "a", title: long, summary: long } },
          { type: "add_node", node: { id: "b", title: "世界模型", parentId: "a" } },
          { type: "update_node", nodeId: "b", patch: { title: long } },
        ],
      },
      view(),
      meta,
    );

    expect(result.rejected).toEqual([]);
    const added = result.accepted[0];
    if (added?.type !== "add_node") throw new Error("expected add_node");
    expect(added.node.title).toHaveLength(40);
    expect(added.node.title.endsWith("…")).toBe(true);
    expect(long.startsWith(added.node.title.slice(0, 39))).toBe(true);
    expect(added.node.summary).toHaveLength(160);
    // A title that already fits is passed through untouched, so the clamp is not a rewrite.
    const kept = result.accepted[1];
    if (kept?.type !== "add_node") throw new Error("expected add_node");
    expect(kept.node.title).toBe("世界模型");
    // The patch path is the same door: `update_node` can lengthen a title as easily as `add_node`.
    const patched = result.accepted[2];
    if (patched?.type !== "update_node") throw new Error("expected update_node");
    expect(patched.patch.title).toHaveLength(40);
  });

  it("reads a null parentId as no parent, which is how real models mark a root node", () => {
    // Measured on a live endpoint (2026-10-21): deepseek-v4.1-flash, qwen3.8-flash, qwen3.8-max and
    // kimi-k3 all write `"parentId": null` for every top-level node. `optional()` alone rejects an
    // explicit null, so the gate discarded the whole batch — every batch — and a real provider could
    // not grow a map at all. Mock Mode, which never writes null, could not have shown this.
    const result = parseGraphOperations(
      {
        operations: [
          { type: "add_node", node: { id: "root", title: "世界模型", parentId: null, sourceTranscriptIds: ["s-1"] } },
          { type: "add_node", node: { id: "child", title: "预测下一状态", parentId: "root" } },
        ],
      },
      view(),
      meta,
    );

    expect(result.rejected).toEqual([]);
    const root = result.accepted[0];
    if (root?.type !== "add_node") throw new Error("expected add_node");
    expect(root.node.parentId).toBeUndefined();
    const child = result.accepted[1];
    if (child?.type !== "add_node") throw new Error("expected add_node");
    expect(child.node.parentId).toBe("root");
  });

  it("drops a blank summary instead of rejecting the batch that carried it", () => {
    // The MindMap prompt started asking for one summary per node on 2026-10-21 (§13 OPEN-8), which makes
    // `"summary": ""` an output shape a real model can hand back. `min(1)` alone rejected that node, and a
    // rejected node takes its whole batch with it — the failure `parentId: null` was measured causing.
    const result = parseGraphOperations(
      {
        operations: [
          { type: "add_node", node: { id: "root", title: "世界模型", summary: "", sourceTranscriptIds: ["s-1"] } },
          { type: "add_node", node: { id: "second", title: "生成式模拟", summary: "   " } },
          { type: "add_node", node: { id: "third", title: "空间智能", summary: "对三维世界的内部表征" } },
        ],
      },
      view(),
      meta,
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((op) => (op.type === "add_node" ? op.node.summary : undefined))).toEqual([
      undefined,
      undefined,
      "对三维世界的内部表征",
    ]);
  });

  it("normalises a valid batch and stamps bookkeeping the model must not invent", () => {
    const result = parseGraphOperations(
      {
        operations: [
          { type: "add_node", node: { id: "a", title: "人工智能" } },
          { type: "add_node", node: { id: "b", title: "世界模型", parentId: "a" } },
        ],
      },
      view(),
      meta,
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
    const added = result.accepted[0];
    if (added?.type !== "add_node") throw new Error("expected add_node");
    expect(added.node).toEqual({
      id: "a",
      title: "人工智能",
      sourceTranscriptIds: [],
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(added.opId).toBe("resp-1:0");
  });

  it("accepts a bare array as well as an { operations } envelope", () => {
    const asArray = parseGraphOperations([{ type: "delete_node", nodeId: "a" }], view({ hasNode: () => true }), meta);
    expect(asArray.accepted).toHaveLength(1);
  });

  it("resolves parents created earlier in the same batch", () => {
    const result = parseGraphOperations(
      [
        { type: "add_node", node: { id: "p", title: "父" } },
        { type: "add_node", node: { id: "c", title: "子", parentId: "p" } },
      ],
      view(),
      meta,
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
  });

  it("rejects an orphan parent instead of creating a dangling node", () => {
    const result = parseGraphOperations(
      [{ type: "add_node", node: { id: "c", title: "子", parentId: "missing" } }],
      view(),
      meta,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("orphan_parent");
  });

  it("attaches a child that was listed before its parent", () => {
    const result = parseGraphOperations(
      [
        { type: "add_node", node: { id: "c", title: "子", parentId: "p" } },
        { type: "add_node", node: { id: "p", title: "父" } },
      ],
      view(),
      meta,
    );
    expect(result.rejected).toEqual([]);
    // The parent must be applied first, but keeps the opId of the item it actually arrived as.
    expect(result.accepted.map((op) => (op.type === "add_node" ? op.node.id : "?"))).toEqual(["p", "c"]);
    expect(result.accepted.map((op) => op.opId)).toEqual(["resp-1:1", "resp-1:0"]);
  });

  it("resolves a bottom-up chain over several passes", () => {
    const result = parseGraphOperations(
      [
        { type: "add_node", node: { id: "g", title: "孙", parentId: "c" } },
        { type: "add_node", node: { id: "c", title: "子", parentId: "p" } },
        { type: "add_node", node: { id: "p", title: "父" } },
      ],
      view(),
      meta,
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(3);
  });

  it("waits for an edge endpoint that arrives later in the batch", () => {
    const result = parseGraphOperations(
      [
        { type: "add_edge", edge: { id: "e1", source: "a", target: "b" } },
        { type: "add_node", node: { id: "a", title: "甲" } },
        { type: "add_node", node: { id: "b", title: "乙" } },
      ],
      view(),
      meta,
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((op) => op.type)).toEqual(["add_node", "add_node", "add_edge"]);
  });

  it("gives up after one fruitless pass instead of spinning", () => {
    const result = parseGraphOperations(
      [
        { type: "update_node", nodeId: "ghost", patch: { title: "改名" } },
        { type: "delete_node", nodeId: "also-ghost" },
      ],
      view(),
      meta,
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual(["unknown_node", "unknown_node"]);
  });

  it("rejects schema-invalid operations without throwing", () => {
    const result = parseGraphOperations(
      [
        { type: "add_node", node: { id: "a", title: "" } },
        { type: "nonsense" },
        null,
        { type: "update_node", nodeId: "a", patch: {} },
      ],
      view({ hasNode: () => true }),
      meta,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["schema", "schema", "schema", "schema"]);
  });

  it("treats a repeated opId as a duplicate, keeping updates idempotent", () => {
    const seen = view({ hasNode: () => true, isOpSeen: (id) => id === "dup" });
    const result = parseGraphOperations(
      [{ opId: "dup", type: "delete_node", nodeId: "a" }, { opId: "dup", type: "delete_node", nodeId: "a" }],
      seen,
      meta,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["duplicate_op", "duplicate_op"]);
  });

  it("refuses a move that would create a cycle", () => {
    const result = parseGraphOperations(
      [{ type: "move_node", nodeId: "a", parentId: "b" }],
      view({ hasNode: () => true, isDescendantOrSelf: (descendant, ancestor) => descendant === "b" && ancestor === "a" }),
      meta,
    );
    expect(result.rejected[0]?.reason).toBe("cycle");
  });

  /** Merging re-parents the source's children onto the target, so a target below the source cycles. */
  it("refuses a merge whose target is a descendant of the source", () => {
    const result = parseGraphOperations(
      [{ type: "merge_node", sourceNodeId: "a", targetNodeId: "c" }],
      view({ hasNode: () => true, isDescendantOrSelf: (descendant, ancestor) => descendant === "c" && ancestor === "a" }),
      meta,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("cycle");
  });

  it("refuses a node moving under itself", () => {
    const result = parseGraphOperations(
      [{ type: "move_node", nodeId: "a", parentId: "a" }],
      view({ hasNode: () => true }),
      meta,
    );
    expect(result.rejected[0]?.reason).toBe("self_relation");
  });

  it("never throws on unparseable input, which is the whole point of the gate", () => {
    expect(() => parseGraphOperations("not json", view(), meta)).not.toThrow();
    expect(parseGraphOperations(undefined, view(), meta).rejected[0]?.reason).toBe("schema");
  });
});
