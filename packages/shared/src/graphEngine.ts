import type { GraphOperation as Op, GraphReadView } from "./graph.js";
import type { MindMapEdge, MindMapNode } from "./types.js";

/**
 * The canonical graph reducer. Backend and frontend both run this exact function, so the rendered
 * tree cannot diverge from the stored one. Operations are applied in order; an operation that
 * references a node the local state does not have is skipped rather than guessed at — a client
 * that missed a frame may legitimately lag behind.
 */

export const ROOT = "";

export interface GraphState {
  nodes: Record<string, MindMapNode>;
  edges: Record<string, MindMapEdge>;
  /** Child order per parent key; `ROOT` holds top-level nodes. Order is the mind-map reading order. */
  childOrder: Record<string, string[]>;
  seenOps: Set<string>;
}

export function createGraphState(): GraphState {
  return { nodes: {}, edges: {}, childOrder: { [ROOT]: [] }, seenOps: new Set() };
}

export function isDescendantOrSelf(state: GraphState, maybeDescendant: string, ancestor: string): boolean {
  let cursor: string | undefined = maybeDescendant;
  const guard = new Set<string>();
  while (cursor !== undefined) {
    if (cursor === ancestor) return true;
    if (guard.has(cursor)) return false;
    guard.add(cursor);
    cursor = state.nodes[cursor]?.parentId;
  }
  return false;
}

export function graphReadView(state: GraphState): GraphReadView {
  return {
    hasNode: (id) => state.nodes[id] !== undefined,
    isDescendantOrSelf: (maybeDescendant, ancestor) => isDescendantOrSelf(state, maybeDescendant, ancestor),
    isOpSeen: (opId) => state.seenOps.has(opId),
  };
}

function detached(state: GraphState): GraphState {
  return { nodes: { ...state.nodes }, edges: { ...state.edges }, childOrder: { ...state.childOrder }, seenOps: state.seenOps };
}

function removeFromOrder(state: GraphState, parentId: string, nodeId: string): string[] {
  const siblings = state.childOrder[parentId] ?? [];
  return siblings.filter((id) => id !== nodeId);
}

function appendToOrder(state: GraphState, parentId: string, nodeId: string): string[] {
  const siblings = state.childOrder[parentId] ?? [];
  return siblings.includes(nodeId) ? siblings : [...siblings, nodeId];
}

/**
 * `delete_node` keeps the subtree: children are re-parented to the deleted node's parent instead of
 * vanishing with it, because an LLM deleting a mis-named heading must not erase the knowledge below.
 */
function deleteNode(next: GraphState, nodeId: string, touched: string[]): void {
  const node = next.nodes[nodeId];
  if (!node) return;
  const parentId = node.parentId ?? ROOT;
  const children = next.childOrder[nodeId] ?? [];

  for (const childId of children) {
    const child = next.nodes[childId];
    if (!child) continue;
    next.nodes[childId] = { ...child, parentId: node.parentId, updatedAt: Date.now() };
    next.childOrder[parentId] = appendToOrder(next, parentId, childId);
    touched.push(childId);
  }

  delete next.nodes[nodeId];
  delete next.childOrder[nodeId];
  next.childOrder[parentId] = removeFromOrder(next, parentId, nodeId);

  for (const [edgeId, edge] of Object.entries(next.edges)) {
    if (edge.source === nodeId || edge.target === nodeId) delete next.edges[edgeId];
  }
  touched.push(nodeId);
}

function mergeNodes(next: GraphState, sourceNodeId: string, targetNodeId: string, at: number, touched: string[]): void {
  const source = next.nodes[sourceNodeId];
  const target = next.nodes[targetNodeId];
  if (!source || !target) return;

  const mergedIds = [...new Set([...target.sourceTranscriptIds, ...source.sourceTranscriptIds])];
  next.nodes[targetNodeId] = {
    ...target,
    sourceTranscriptIds: mergedIds,
    summary: target.summary ?? source.summary,
    updatedAt: at,
  };

  const sourceChildren = next.childOrder[sourceNodeId] ?? [];
  for (const childId of sourceChildren) {
    const child = next.nodes[childId];
    if (!child) continue;
    next.nodes[childId] = { ...child, parentId: targetNodeId, updatedAt: at };
    next.childOrder[targetNodeId] = appendToOrder(next, targetNodeId, childId);
    touched.push(childId);
  }

  const parentId = source.parentId ?? ROOT;
  next.childOrder[parentId] = removeFromOrder(next, parentId, sourceNodeId);
  delete next.nodes[sourceNodeId];
  delete next.childOrder[sourceNodeId];

  for (const [edgeId, edge] of Object.entries(next.edges)) {
    if (edge.source !== sourceNodeId && edge.target !== sourceNodeId) continue;
    const other = edge.source === sourceNodeId ? edge.target : edge.source;
    if (other === targetNodeId) {
      delete next.edges[edgeId];
      continue;
    }
    next.edges[edgeId] = {
      ...edge,
      id: `${edgeId}#m`,
      source: edge.source === sourceNodeId ? targetNodeId : edge.source,
      target: edge.target === sourceNodeId ? targetNodeId : edge.target,
    };
  }
  touched.push(targetNodeId, sourceNodeId);
}

export interface ApplyResult {
  state: GraphState;
  touched: string[];
  /** Ops the local state could not apply; the client is behind, so they are logged, not retried. */
  skipped: string[];
}

/** Pure in, pure out: the returned state is a new object, the input is never mutated. */
export function applyOperation(state: GraphState, op: Op): ApplyResult {
  return applyOperations(state, [op]);
}

function applyOne(state: GraphState, op: Op, seen: Set<string>): ApplyResult {
  if (seen.has(op.opId)) return { state, touched: [], skipped: [op.opId] };

  const next = detached(state);
  const touched: string[] = [];
  const skipped: string[] = [];

  const exists = (id: string) => next.nodes[id] !== undefined;

  switch (op.type) {
    case "add_node": {
      if (exists(op.node.id)) {
        skipped.push(op.opId);
        break;
      }
      const parentId = op.node.parentId ?? ROOT;
      if (parentId !== ROOT && !exists(parentId)) {
        skipped.push(op.opId);
        break;
      }
      next.nodes[op.node.id] = op.node;
      next.childOrder[parentId] = appendToOrder(next, parentId, op.node.id);
      touched.push(op.node.id);
      break;
    }
    case "update_node": {
      const current = next.nodes[op.nodeId];
      if (!current) {
        skipped.push(op.opId);
        break;
      }
      next.nodes[op.nodeId] = { ...current, ...op.patch, updatedAt: op.stampedAt };
      touched.push(op.nodeId);
      break;
    }
    case "move_node": {
      const current = next.nodes[op.nodeId];
      if (!current || !exists(op.parentId)) {
        skipped.push(op.opId);
        break;
      }
      if (isDescendantOrSelf(next, op.parentId, op.nodeId)) {
        skipped.push(op.opId);
        break;
      }
      next.childOrder[current.parentId ?? ROOT] = removeFromOrder(next, current.parentId ?? ROOT, op.nodeId);
      next.nodes[op.nodeId] = { ...current, parentId: op.parentId, updatedAt: op.stampedAt };
      next.childOrder[op.parentId] = appendToOrder(next, op.parentId, op.nodeId);
      touched.push(op.nodeId);
      break;
    }
    case "merge_node": {
      if (!exists(op.sourceNodeId) || !exists(op.targetNodeId)) {
        skipped.push(op.opId);
        break;
      }
      // Same cycle the gate refuses, held here too: replayed snapshots and other clients apply
      // operations through this function without ever passing the gate.
      if (isDescendantOrSelf(next, op.targetNodeId, op.sourceNodeId)) {
        skipped.push(op.opId);
        break;
      }
      mergeNodes(next, op.sourceNodeId, op.targetNodeId, op.stampedAt, touched);
      break;
    }
    case "delete_node": {
      if (!exists(op.nodeId)) {
        skipped.push(op.opId);
        break;
      }
      deleteNode(next, op.nodeId, touched);
      break;
    }
    case "add_edge": {
      if (!exists(op.edge.source) || !exists(op.edge.target)) {
        skipped.push(op.opId);
        break;
      }
      next.edges[op.edge.id] = op.edge;
      touched.push(op.edge.source, op.edge.target);
      break;
    }
  }

  next.seenOps = seen;
  seen.add(op.opId);
  return { state: next, touched, skipped };
}

export function applyOperations(state: GraphState, ops: readonly Op[]): ApplyResult {
  if (ops.length === 0) return { state, touched: [], skipped: [] };
  // One copy of the operation log per batch, not per operation: this set is the largest thing in the
  // state, and a session that replays thousands of them through a two-op batch would otherwise spend
  // its time copying a set nobody reads.
  const seen = new Set(state.seenOps);
  let cursor = state;
  const touched = new Set<string>();
  const skipped: string[] = [];
  for (const op of ops) {
    const result = applyOne(cursor, op, seen);
    cursor = result.state;
    for (const id of result.touched) touched.add(id);
    skipped.push(...result.skipped);
  }
  return { state: cursor, touched: [...touched], skipped };
}

/** Flat list in reading order, used by both the layout pass and the REST snapshot. */
export function toNodeList(state: GraphState): MindMapNode[] {
  const out: MindMapNode[] = [];
  const visit = (key: string) => {
    for (const id of state.childOrder[key] ?? []) {
      const node = state.nodes[id];
      if (!node) continue;
      out.push(node);
      visit(id);
    }
  };
  visit(ROOT);
  return out;
}

