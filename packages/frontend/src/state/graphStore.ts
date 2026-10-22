import { create } from "zustand";
import {
  applyOperations,
  createGraphState,
  type GraphOperation,
  type GraphState,
  type MindMapEdge,
  type MindMapNode,
} from "@rcc/shared";
import { layoutGraph, type Placement } from "./layout";

/**
 * The client keeps the same reducer as the backend, so the rendered tree is derived from the same
 * operations the store persisted. Positions are derived here, except the ones the user dragged to:
 * those come back from the server with the snapshot, so a reconnect does not move a map the user has
 * already arranged.
 */
interface GraphStore {
  graph: GraphState;
  positions: Record<string, Placement>;
  /** Dragged nodes win over the layout, which is what makes a hand-arranged map survive growth. */
  pinned: Record<string, Placement>;
  collapsed: Record<string, boolean>;
  /** Operation ids the local state could not apply, meaning this client missed their predecessors. */
  staleOpIds: string[];
  /**
   * True when the current `staleOpIds` came from the snapshot itself. A live gap closes on reconnect;
   * a gap the snapshot produced is the reconnect, so the panel must not promise it will heal.
   */
  snapshotStale: boolean;
  applyOps(operations: readonly GraphOperation[]): void;
  hydrate(nodes: MindMapNode[], edges: MindMapEdge[], savedPositions?: Record<string, Placement>): void;
  pinNode(id: string, at: Placement): void;
  toggleCollapsed(id: string): void;
  reset(): void;
}

export const useGraphStore = create<GraphStore>()((set, get) => ({
  graph: createGraphState(),
  positions: {},
  pinned: {},
  collapsed: {},
  staleOpIds: [],
  snapshotStale: false,

  applyOps: (operations) => {
    const state = get().graph;
    // A replayed frame is normal (snapshot + live overlap); it is not evidence that the client is
    // behind, so drop it before the reducer and keep `staleOpIds` meaning only real gaps.
    const fresh = operations.filter((op) => !state.seenOps.has(op.opId));
    if (fresh.length === 0) return;
    const result = applyOperations(state, fresh);
    set({
      graph: result.state,
      // Kept across batches: a gap the next frame happens not to repeat is still a gap this client
      // has, and only a snapshot can close it. Bounded because the list is a warning, not a ledger.
      staleOpIds: [...new Set([...get().staleOpIds, ...result.skipped])].slice(-100),
      positions: layoutGraph(result.state, get().positions, get().pinned, get().collapsed),
    });
  },

  hydrate: (nodes, edges, savedPositions = {}) => {
    const { ops, stranded } = snapshotOperations(nodes, edges);
    const result = applyOperations(createGraphState(), ops);
    const pinned = { ...get().pinned, ...savedPositions };
    set({
      graph: result.state,
      pinned,
      staleOpIds: result.skipped,
      snapshotStale: stranded.length > 0,
      // A snapshot is also what a reconnect receives, so the coordinates this client already had are
      // fed back in as `known`: dropping them would re-anchor every tree at (0,0) on each reconnect.
      positions: layoutGraph(result.state, { ...get().positions, ...savedPositions }, pinned, get().collapsed),
    });
  },

  pinNode: (id, at) => {
    const pinned = { ...get().pinned, [id]: at };
    set({ pinned, positions: { ...get().positions, [id]: at } });
  },

  toggleCollapsed: (id) => {
    const collapsed = { ...get().collapsed, [id]: !(get().collapsed[id] ?? false) };
    const state = get().graph;
    set({ collapsed, positions: layoutGraph(state, get().positions, get().pinned, collapsed) });
  },

  reset: () =>
    set({ graph: createGraphState(), positions: {}, pinned: {}, collapsed: {}, staleOpIds: [], snapshotStale: false }),
}));

/**
 * A snapshot is replayed through the reducer rather than assigned, so both paths cannot diverge.
 * Stranded nodes — a parent that is gone, or a cycle written before the merge gate existed — are
 * emitted anyway rather than dropped: the reducer refuses them, their opIds land in `skipped`, and a
 * subtree that cannot be attached stops being invisible. `stranded` says the snapshot itself caused
 * it, which is the difference between "reconnect heals this" and "reconnect is what failed".
 */
function snapshotOperations(
  nodes: readonly MindMapNode[],
  edges: readonly MindMapEdge[],
): { ops: GraphOperation[]; stranded: string[] } {
  const pending = [...nodes];
  const placed = new Set<string>();
  const stranded: string[] = [];
  const ops: GraphOperation[] = [];

  while (pending.length > 0) {
    const index = pending.findIndex((node) => !node.parentId || placed.has(node.parentId));
    const [node] = pending.splice(index === -1 ? 0 : index, 1);
    if (!node) break;
    if (index === -1) stranded.push(node.id);
    else placed.add(node.id);
    ops.push({ type: "add_node", opId: `snapshot:${node.id}`, node });
  }

  for (const edge of edges) {
    // Endpoints that never got attached are already reported as their own skip; counting their edges
    // too would inflate the number without naming a second problem.
    if (!placed.has(edge.source) || !placed.has(edge.target)) continue;
    ops.push({ type: "add_edge", opId: `snapshot:${edge.id}`, edge });
  }
  return { ops, stranded };
}
