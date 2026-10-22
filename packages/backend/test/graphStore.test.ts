import { describe, expect, it, vi } from "vitest";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { GraphStore } from "../src/graph/GraphStore.js";
import { createBus } from "../src/bus/eventBus.js";
import { graphReadView, parseGraphOperations, type GraphOperation } from "@rcc/shared";
import type { MindMapNode } from "@rcc/shared";
import { tick } from "./helpers.js";

function node(id: string, title: string, parentId?: string, createdAt = 1): MindMapNode {
  return {
    id,
    title,
    ...(parentId ? { parentId } : {}),
    sourceTranscriptIds: [`${id}-t`],
    createdAt,
    updatedAt: createdAt,
  };
}

function setup() {
  const store = openSqlite(":memory:");
  new SqliteSessionRepository(store.db).create({ id: "s1", startedAt: 1, status: "recording" });
  const repo = new SqliteGraphRepository(store.db);
  const bus = createBus();
  return { store, repo, bus, graph: new GraphStore(bus, repo, "s1") };
}

/** The validation gate is covered in `@rcc/shared`; these tests feed it normalised operations. */
function addOp(opId: string, n: MindMapNode): GraphOperation {
  return { type: "add_node", opId, node: n };
}

describe("Graph Store", () => {
  it("applies operations, persists them, and publishes touched nodes", async () => {
    const { graph, repo, bus } = setup();
    const upserts: string[] = [];
    bus.on("mindmap", "mindmap.node.upserted", (node2) => {
      upserts.push(node2.id);
    });

    graph.applyOps([addOp("r1:0", node("a", "人工智能"))], "r1");
    await tick();

    expect(repo.loadNodes("s1").map((row) => row.id)).toEqual(["a"]);
    expect(upserts).toEqual(["a"]);
  });

  it("re-applying the same response does not duplicate nodes", () => {
    const { graph, repo } = setup();
    const ops = [addOp("r1:0", node("a", "人工智能"))];
    graph.applyOps(ops, "r1");
    graph.applyOps(ops, "r1");

    expect(repo.loadNodes("s1")).toHaveLength(1);
  });

  it("restores both the tree and the operation log on hydrate", () => {
    const { repo, bus } = setup();
    const first = new GraphStore(bus, repo, "s1");
    first.applyOps([addOp("r1:0", node("a", "人工智能"))], "r1");

    const reopened = new GraphStore(bus, repo, "s1");
    reopened.hydrate();
    expect(reopened.snapshot().nodes.map((row) => row.id)).toEqual(["a"]);

    // The replayed response is recognised as already applied, both by the gate and by the reducer.
    const replay = parseGraphOperations(
      [{ type: "add_node", node: node("a", "人工智能") }],
      graphReadView(reopened.graphState),
      { responseId: "r1", now: 2 },
    );
    expect(replay.accepted).toHaveLength(0);
    expect(replay.rejected[0]?.reason).toBe("duplicate_op");
    expect(reopened.applyOps([addOp("r1:0", node("a", "人工智能"))], "r1").skipped).toEqual(["r1:0"]);
  });

  it("removes the node row when the graph deletes it", () => {
    const { graph, repo } = setup();
    graph.applyOps([addOp("r1:0", node("a", "人工智能"))], "r1");
    graph.applyOps([{ type: "delete_node", opId: "r2:0", nodeId: "a" }], "r2");
    expect(repo.loadNodes("s1")).toEqual([]);
  });

  it("survives a restart with the cross-links the model proposed", () => {
    const { repo, bus } = setup();
    const first = new GraphStore(bus, repo, "s1");
    first.applyOps([addOp("r1:0", node("a", "人工智能"))], "r1");
    first.applyOps([addOp("r2:0", node("b", "世界模型", "a"))], "r2");
    first.applyOps(
      [{ type: "add_edge", opId: "r3:0", edge: { id: "e1", source: "b", target: "a", relation: "related" } }],
      "r3",
    );

    // Hierarchy needs no row here — it lives in parent_id. Only the extra link can be lost, and it
    // was: the table existed, `hydrate()` read it, and nothing ever wrote it.
    expect(repo.loadEdges("s1")).toEqual([{ id: "e1", source: "b", target: "a", relation: "related" }]);
    const reopened = new GraphStore(bus, repo, "s1");
    reopened.hydrate();
    expect(reopened.snapshot().edges).toEqual([{ id: "e1", source: "b", target: "a", relation: "related" }]);
  });

  it("keeps the previous edge mirror when a save fails half-way", () => {
    const { repo } = setup();
    repo.saveEdges("s1", [{ id: "e1", source: "a", target: "b" }]);
    // `source` is NOT NULL, so this row stands in for any statement that throws after the DELETE at
    // the top of `saveEdges` has already run.
    expect(() =>
      repo.saveEdges("s1", [
        { id: "e2", source: "c", target: "d" },
        { id: "e3", source: undefined as unknown as string, target: "d" },
      ]),
    ).toThrow();

    expect(repo.loadEdges("s1")).toEqual([{ id: "e1", source: "a", target: "b" }]);
  });

  it("rolls the whole batch back when a write fails, in memory as well as on disk", async () => {
    const { graph, repo, bus } = setup();
    const upserts: string[] = [];
    bus.on("mindmap", "mindmap.node.upserted", (node2) => {
      upserts.push(node2.id);
    });
    graph.applyOps([addOp("r1:0", node("a", "人工智能"))], "r1");

    const upsertNode = repo.upsertNode.bind(repo);
    repo.upsertNode = (sessionId, node2) => {
      if (node2.id === "b") throw new Error("disk full");
      upsertNode(sessionId, node2);
    };

    expect(() => graph.applyOps([addOp("r2:0", node("b", "世界模型", "a"))], "r2")).toThrow("disk full");
    await tick();

    expect(graph.snapshot().nodes.map((row) => row.id)).toEqual(["a"]);
    expect(repo.loadNodes("s1").map((row) => row.id)).toEqual(["a"]);
    expect(upserts).toEqual(["a"]);
    // The op id must not survive its own rollback: a recorded-but-absent operation would be swallowed
    // by the duplicate gate, so the model's retry of that batch could never land.
    expect(repo.seenOpIds("s1")).toEqual(["r1:0"]);
  });

  it("does not persist sibling order: a restart returns children in creation order", () => {
    // Deliberate boundary, not an oversight. `childOrder` is the one piece of graph state with no
    // column: the node row stores `parent_id` but nowhere a place within the sibling list, so
    // `hydrate()` rebuilds the list from `created_at`. What would have to be saved is a reorder the
    // product never produces — measured over the op logs in `.scratch/*.sqlite`: 660 operations, all
    // 660 `add_node`, and the drag gesture that reorders the picture sends `mindmap.node.moved`, which
    // is a position (§8). A same-parent `move_node` would be reordered back by the restart, and this
    // test states that cost out loud instead of leaving it to a comment.
    const { repo, bus } = setup();
    const first = new GraphStore(bus, repo, "s1");
    first.applyOps([addOp("r1:0", node("a", "人工智能", undefined, 1))], "r1");
    first.applyOps([addOp("r2:0", node("b", "世界模型", "a", 2))], "r2");
    first.applyOps([addOp("r3:0", node("c", "仿真差距", "a", 3))], "r3");
    first.applyOps([{ type: "move_node", opId: "r4:0", nodeId: "b", parentId: "a", stampedAt: 4 }], "r4");
    expect(first.graphState.childOrder.a).toEqual(["c", "b"]);

    const reopened = new GraphStore(bus, repo, "s1");
    reopened.hydrate();
    expect(reopened.snapshot().nodes.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(reopened.graphState.childOrder.a).toEqual(["b", "c"]);
  });

  it("keeps positions on the client side: the store only writes what it is given", () => {
    const { graph, repo } = setup();
    graph.savePosition("a", 120, 40, true);
    expect(repo.loadPositions("s1")).toEqual({ a: { x: 120, y: 40, pinned: true } });
  });

  it("publishes nothing for an empty operation batch", () => {
    const { graph, bus } = setup();
    const spy = vi.fn();
    bus.on("mindmap", "mindmap.node.upserted", spy);
    expect(graph.applyOps([], "r1")).toEqual({ touched: [], skipped: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});
