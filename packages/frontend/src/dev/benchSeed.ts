import type { GraphOperation, MindMapNode } from "@rcc/shared";
import { useGraphStore } from "../state/graphStore";

/**
 * A deterministic node seed so "is the map smooth at N nodes" is a measurement rather than a wait for
 * a real corpus to grow that large (§52 Test F, ADR OPEN-5).
 *
 * It is deliberately client-only: nothing is sent to the backend, so there is no session, no
 * `mindmap.node.upserted` traffic and no rows. `/api/debug`'s `mindmap.nodeCount` therefore reads 0
 * while the screen holds N nodes — that is the point, not a data-loss bug, and it is why the driver
 * asserts against `document.querySelectorAll(".react-flow__node")` instead of the server gauge. A
 * seeded node drag also cannot persist, because `mindmap.node.moved` is ignored for ids the server
 * does not know — which is the compliant behaviour, since §43 only ever persists drags.
 */

/** Six top-level trees, because one 1000-node tree would measure a layout the product never runs. */
const ROOT_COUNT = 6;
const MAX_DEPTH = 4;
export const MAX_BENCH_NODES = 2000;

export interface BenchHandle {
  /** Grows the map to `count` nodes. Cheap to call again: replayed operations are dropped by `seenOps`. */
  seed(count: number): number;
}

declare global {
  interface Window {
    __rccBench?: BenchHandle;
  }
}

/** The same 32-bit LCG as `.scratch/bench-scan.ts`, so no faker dependency enters the graph. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

export function parseBenchCount(search: string): number {
  const raw = new URLSearchParams(search).get("bench");
  if (raw === null || raw === "") return 0;
  return toCount(Number(raw));
}

export function toCount(value: number): number {
  if (!Number.isFinite(value) || !(value > 0)) return 0;
  return Math.min(Math.trunc(value), MAX_BENCH_NODES);
}

/** Parents always precede children, so the reducer skips nothing and `staleOpIds` stays empty. */
export function buildBenchOperations(count: number): GraphOperation[] {
  const total = toCount(count);
  const next = lcg(0x5eed);
  const ops: GraphOperation[] = [];
  const depthOf: number[] = [];
  const attachable: number[] = [];

  for (let index = 0; index < total; index++) {
    const isRoot = index < ROOT_COUNT;
    const parentIndex = isRoot ? -1 : pickParent(next, attachable);
    const depth = isRoot ? 0 : (depthOf[parentIndex] ?? 0) + 1;
    depthOf[index] = depth;
    ops.push({
      type: "add_node",
      opId: `bench-op-${index}`,
      node: benchNode(index, depth, isRoot ? undefined : `bench-${parentIndex}`, next),
    });
    if (depth < MAX_DEPTH) attachable.push(index);
  }
  return ops;
}

function pickParent(next: () => number, attachable: number[]): number {
  return attachable[next() % attachable.length] ?? 0;
}

function benchNode(index: number, depth: number, parentId: string | undefined, next: () => number): MindMapNode {
  const sources = 1 + (next() % 3);
  return {
    id: `bench-${index}`,
    title: `基准主题 ${index}`,
    parentId,
    summary: `第 ${depth} 层`,
    sourceTranscriptIds: Array.from({ length: sources }, (_, k) => `bench-t-${index}-${k}`),
    createdAt: index,
    updatedAt: index,
    confidence: 0.6 + (next() % 40) / 100,
  };
}

/** Called from `main.tsx` before the first render, so React Flow's mount-time `fitView` frames the map. */
export function installBenchSeed(): void {
  const count = parseBenchCount(window.location.search);
  if (count === 0) return;
  const seed = (target: number): number => {
    useGraphStore.getState().applyOps(buildBenchOperations(target));
    return Object.keys(useGraphStore.getState().graph.nodes).length;
  };
  seed(count);
  window.__rccBench = { seed };
}
