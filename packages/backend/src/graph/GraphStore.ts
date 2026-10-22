import {
  applyOperations,
  createGraphState,
  toNodeList,
  type GraphOperation,
  type GraphState,
} from "@rcc/shared";
import type { AppBus } from "../bus/eventBus.js";
import type { SqliteGraphRepository } from "../store/graphRepository.js";

/**
 * Graph authority. Model output has already passed `parseGraphOperations`; this layer applies it
 * through the shared reducer, persists what changed, and publishes touched nodes. Positions are
 * owned by the client (ADR §8), so the store never writes coordinates.
 */
export class GraphStore {
  private state: GraphState = createGraphState();

  constructor(
    private readonly bus: AppBus,
    private readonly repo: SqliteGraphRepository,
    private readonly sessionId: string,
  ) {}

  /**
   * Load what the database holds for *this* session, so a store built over an existing session id does
   * not start from an empty tree. Op ids make replay idempotent. Two callers reach it today, and the
   * difference between them is the whole of OPEN-7: `RecordingController.start()` always builds over a
   * freshly minted id, so a restarted backend answers `/api/session` with no nodes even though the
   * previous session's rows are on disk; `openHistory()` builds over an id the import just wrote, which
   * is how a saved session gets back onto the screen (§6.5 D-34). Nothing here lists or picks sessions.
   */
  hydrate(): void {
    const nodes = this.repo.loadNodes(this.sessionId);
    const edges = this.repo.loadEdges(this.sessionId);
    const state = createGraphState();
    for (const node of nodes) {
      state.nodes[node.id] = node;
      const parentKey = node.parentId ?? "";
      // `loadNodes` comes back in `created_at` order, so sibling order after a restart is creation
      // order: the row carries `parent_id` but no position within the sibling list. Accepted, because
      // what a user reorders by hand is a node's coordinates (§8 — a drag sends `mindmap.node.moved`,
      // not a `move_node`), and a reparent that does change the tree survives in `parent_id`.
      // Pinned by a test in `graphStore.test.ts`.
      state.childOrder[parentKey] = [...(state.childOrder[parentKey] ?? []), node.id];
    }
    for (const edge of edges) state.edges[edge.id] = edge;
    for (const opId of this.repo.seenOpIds(this.sessionId)) state.seenOps.add(opId);
    this.state = state;
  }

  applyOps(operations: readonly GraphOperation[], responseId: string): { touched: string[]; skipped: string[] } {
    if (operations.length === 0) return { touched: [], skipped: [] };
    const result = applyOperations(this.state, operations);
    const at = Date.now();
    // The batch reaches SQLite before it reaches `this.state` or the bus. Writing in the other order
    // means a disk failure leaves the store holding nodes nobody else can see: `MindMapAgent`
    // downgrades it to a recoverable `update_failed`, so the client keeps rendering a tree the
    // restart will not reproduce — and the rolled-back op ids are the proof, because recording an
    // operation that never committed would make the gate swallow the model's retry forever.
    this.repo.transaction(() => {
      for (const op of operations) {
        this.repo.recordOperation(this.sessionId, op.opId, op.type, responseId, op, at);
      }
      for (const nodeId of result.touched) {
        const node = result.state.nodes[nodeId];
        if (node) this.repo.upsertNode(this.sessionId, node);
        else this.repo.deleteNode(this.sessionId, nodeId);
      }
      this.repo.saveEdges(this.sessionId, Object.values(result.state.edges));
    });

    this.state = result.state;
    for (const nodeId of result.touched) {
      const node = this.state.nodes[nodeId];
      if (node) this.bus.emit("mindmap.node.upserted", node);
    }
    return { touched: result.touched, skipped: result.skipped };
  }

  snapshot() {
    return { nodes: toNodeList(this.state), edges: Object.values(this.state.edges) };
  }

  positions() {
    return this.repo.loadPositions(this.sessionId);
  }

  /** Audit trail for the debug panel (§48); the op log is append-only. */
  recentOperations(limit = 20) {
    return this.repo.recentOperations(this.sessionId, limit);
  }

  savePosition(nodeId: string, x: number, y: number, pinned: boolean): void {
    this.repo.savePosition(this.sessionId, nodeId, x, y, pinned);
  }

  get graphState(): GraphState {
    return this.state;
  }
}
