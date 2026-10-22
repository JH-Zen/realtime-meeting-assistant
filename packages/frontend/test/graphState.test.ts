import { beforeEach, describe, expect, it } from "vitest";
import { ROOT, toNodeList, type GraphOperation, type MindMapEdge, type MindMapNode } from "@rcc/shared";
import { visibleNodes } from "../src/state/layout";
import { useGraphStore } from "../src/state/graphStore";

/**
 * These are the invariants the UI exists to protect: the map must not jump when the model grows it,
 * a dragged node must stay where it was dragged, and a replayed frame must be inert.
 */

function node(id: string, parentId?: string): MindMapNode {
  return { id, title: id, parentId, sourceTranscriptIds: [], createdAt: 0, updatedAt: 0 };
}

function add(opId: string, value: MindMapNode): GraphOperation {
  return { type: "add_node", opId, node: value };
}

const positions = () => useGraphStore.getState().positions;
const graph = () => useGraphStore.getState().graph;

describe("frontend graph state", () => {
  beforeEach(() => {
    useGraphStore.getState().reset();
  });

  it("does not move an existing tree when a new root is appended", () => {
    useGraphStore.getState().applyOps([add("op-a", node("a")), add("op-a1", node("a1", "a"))]);
    const before = positions();

    useGraphStore.getState().applyOps([add("op-b", node("b")), add("op-b1", node("b1", "b"))]);

    expect(positions().a).toEqual(before.a);
    expect(positions().a1).toEqual(before.a1);
    expect(positions().b).toBeDefined();
    expect(graph().childOrder[ROOT]).toEqual(["a", "b"]);
  });

  it("keeps reporting an earlier gap after a batch that applies cleanly", () => {
    // A child whose parent never arrived is skipped, and the next frame landing cleanly is not proof
    // this client caught up — only the reconnect snapshot is.
    useGraphStore.getState().applyOps([add("op-orphan", node("x", "n-missing-parent"))]);
    expect(useGraphStore.getState().staleOpIds).toEqual(["op-orphan"]);

    useGraphStore.getState().applyOps([add("op-a", node("a"))]);
    expect(useGraphStore.getState().staleOpIds).toEqual(["op-orphan"]);
  });

  it("lets a dragged node win over the layout on every later update", () => {
    useGraphStore.getState().applyOps([add("op-a", node("a"))]);
    useGraphStore.getState().pinNode("a", { x: 900, y: 400 });
    useGraphStore.getState().applyOps([add("op-a1", node("a1", "a"))]);

    expect(positions().a).toEqual({ x: 900, y: 400 });
    expect(positions().a1).toBeDefined();
  });

  it("hides a collapsed subtree from both the layout and the rendered list", () => {
    useGraphStore.getState().applyOps([add("op-a", node("a")), add("op-a1", node("a1", "a"))]);
    expect(positions().a1).toBeDefined();
    expect(visibleNodes(graph(), {}).map((value) => value.id)).toEqual(["a", "a1"]);

    useGraphStore.getState().toggleCollapsed("a");

    expect(positions().a1).toBeUndefined();
    expect(positions().a).toBeDefined();
    expect(visibleNodes(graph(), useGraphStore.getState().collapsed).map((value) => value.id)).toEqual(["a"]);
  });

  it("treats a replayed frame as inert instead of reporting a gap", () => {
    const ops = [add("op-a", node("a")), add("op-a1", node("a1", "a"))];
    useGraphStore.getState().applyOps(ops);
    const before = positions();

    useGraphStore.getState().applyOps(ops);

    expect(positions()).toEqual(before);
    expect(useGraphStore.getState().staleOpIds).toEqual([]);
    expect(toNodeList(graph()).map((value) => value.id)).toEqual(["a", "a1"]);
  });

  it("hydrates a snapshot to the same tree the live operations produced", () => {
    const nodes = [node("a"), node("a1", "a"), node("b")];
    const edges: MindMapEdge[] = [{ id: "e1", source: "a1", target: "b" }];
    useGraphStore.getState().hydrate(nodes, edges);

    expect(toNodeList(graph()).map((value) => value.id)).toEqual(["a", "a1", "b"]);
    expect(graph().childOrder[ROOT]).toEqual(["a", "b"]);
    expect(Object.keys(graph().edges)).toEqual(["e1"]);
    expect(useGraphStore.getState().staleOpIds).toEqual([]);
  });

  it("keeps a re-hydrated snapshot where the map already was", () => {
    // A reconnect hands over the same tree as a snapshot. Re-laying it out from the origin would move
    // every branch the user has been watching, which is exactly what §43 forbids.
    useGraphStore.getState().applyOps([add("op-a", node("a")), add("op-b", node("b"))]);
    const before = positions();

    useGraphStore.getState().hydrate([node("a"), node("b")], []);

    expect(positions()).toEqual(before);
  });

  it("restores a drag that happened on another client", () => {
    useGraphStore.getState().hydrate([node("a"), node("a1", "a")], [], { a1: { x: 640, y: 88 } });

    expect(positions().a1).toEqual({ x: 640, y: 88 });
    // A restored drag is a pin, so later growth cannot pull the node back into the layout.
    expect(useGraphStore.getState().pinned.a1).toEqual({ x: 640, y: 88 });
    useGraphStore.getState().applyOps([add("op-a2", node("a2", "a1"))]);
    expect(positions().a1).toEqual({ x: 640, y: 88 });
  });

  it("reports the nodes a snapshot cannot attach instead of dropping its subtree", () => {
    // `snapshotOperations` used to stop as soon as nothing could be placed, so what stayed behind —
    // a node whose parent is gone, or a cycle written before the merge gate existed — vanished with no
    // signal at all, and the reconnect that is supposed to heal a gap is the very thing that dropped it.
    useGraphStore.getState().hydrate([node("a"), node("x", "gone"), node("x1", "x")], []);

    expect(toNodeList(graph()).map((value) => value.id)).toEqual(["a"]);
    expect(useGraphStore.getState().staleOpIds).toEqual(["snapshot:x", "snapshot:x1"]);
    expect(useGraphStore.getState().snapshotStale).toBe(true);
  });

  it("does not promise a self-heal for a gap the snapshot itself caused", () => {
    // A live gap really does close on the next reconnect; a gap the snapshot produced *is* that
    // reconnect, so the panel must not tell the reader to wait for a heal that already failed.
    useGraphStore.getState().applyOps([add("op-orphan", node("x", "gone"))]);
    expect(useGraphStore.getState().snapshotStale).toBe(false);

    useGraphStore.getState().hydrate([node("a"), node("y", "gone")], []);
    expect(useGraphStore.getState().snapshotStale).toBe(true);

    // A snapshot that lands whole is the heal, so the promise is safe again.
    useGraphStore.getState().hydrate([node("a")], []);
    expect(useGraphStore.getState().snapshotStale).toBe(false);
    expect(useGraphStore.getState().staleOpIds).toEqual([]);
  });

  it("starts over when a new recording begins", () => {
    useGraphStore.getState().applyOps([add("op-a", node("a"))]);
    useGraphStore.getState().reset();

    expect(toNodeList(graph())).toEqual([]);
    expect(positions()).toEqual({});
  });
});
