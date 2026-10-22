import { z } from "zod";
import {
  MindMapEdgeSchema,
  MindMapNodeSchema,
  type MindMapNode,
} from "./types.js";

/** LLM-facing shape: tolerant about bookkeeping fields the model should not invent. */
const LlmNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /**
   * An empty or whitespace-only summary is dropped, not rejected. The prompt started *asking* for
   * one on 2026-10-21 (§13 OPEN-8), so `""` is a shape a real model will hand back, and a rejection
   * here costs the whole batch — the same failure mode that `parentId: null` was measured causing.
   */
  summary: z
    .string()
    .optional()
    .transform((value) => (value !== undefined && value.trim() !== "" ? value : undefined)),
  /**
   * `null` means "top level". Measured on a live endpoint (2026-10-21): deepseek-v4.1-flash,
   * qwen3.8-flash, qwen3.8-max and kimi-k3 all write `"parentId": null` for every root node, and
   * rejecting that cost the graph gate **the whole batch, every batch** — a real provider could not
   * grow a map at all. Other fields were never observed as null, so only this one is widened.
   */
  parentId: z
    .string()
    .min(1)
    .nullish()
    .transform((value) => value ?? undefined),
  sourceTranscriptIds: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1).optional(),
});

/** `parentId` is deliberately absent: re-parenting is `move_node`, not a patch. */
const NodePatchSchema = z
  .object({
    title: z.string().min(1).optional(),
    summary: z
      .string()
      .optional()
      .transform((value) => (value !== undefined && value.trim() !== "" ? value : undefined)),
    confidence: z.number().min(0).max(1).optional(),
    sourceTranscriptIds: z.array(z.string().min(1)).optional(),
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: "patch must change at least one field",
  });

export const GraphOperationInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_node"), opId: z.string().optional(), node: LlmNodeSchema }),
  z.object({
    type: z.literal("update_node"),
    opId: z.string().optional(),
    nodeId: z.string().min(1),
    patch: NodePatchSchema,
  }),
  z.object({
    type: z.literal("move_node"),
    opId: z.string().optional(),
    nodeId: z.string().min(1),
    parentId: z.string().min(1),
  }),
  z.object({
    type: z.literal("merge_node"),
    opId: z.string().optional(),
    sourceNodeId: z.string().min(1),
    targetNodeId: z.string().min(1),
  }),
  z.object({ type: z.literal("delete_node"), opId: z.string().optional(), nodeId: z.string().min(1) }),
  z.object({ type: z.literal("add_edge"), opId: z.string().optional(), edge: MindMapEdgeSchema }),
]);
export type GraphOperationInput = z.infer<typeof GraphOperationInputSchema>;

/** Internal shape after normalisation: `opId` always present, timestamps stamped. */
export type NodePatch = z.infer<typeof NodePatchSchema>;

/**
 * Runtime validator for already-normalised operations. The backend produces these, the
 * frontend re-validates on receipt so a tampered or stale WS frame can never corrupt the graph.
 */
export const GraphOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_node"), opId: z.string(), node: MindMapNodeSchema }),
  z.object({
    type: z.literal("update_node"),
    opId: z.string(),
    nodeId: z.string(),
    patch: z.object({
      title: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
      confidence: z.number().min(0).max(1).optional(),
      sourceTranscriptIds: z.array(z.string().min(1)).optional(),
    }),
    stampedAt: z.number(),
  }),
  z.object({
    type: z.literal("move_node"),
    opId: z.string(),
    nodeId: z.string(),
    parentId: z.string(),
    stampedAt: z.number(),
  }),
  z.object({
    type: z.literal("merge_node"),
    opId: z.string(),
    sourceNodeId: z.string(),
    targetNodeId: z.string(),
    stampedAt: z.number(),
  }),
  z.object({ type: z.literal("delete_node"), opId: z.string(), nodeId: z.string() }),
  z.object({ type: z.literal("add_edge"), opId: z.string(), edge: MindMapEdgeSchema }),
]);

export type GraphOperation = z.infer<typeof GraphOperationSchema>;

export type RejectReason =
  | "schema"
  | "duplicate_op"
  | "duplicate_node_id"
  | "orphan_parent"
  | "unknown_node"
  | "self_relation"
  | "cycle";

export interface RejectedOperation {
  opId: string;
  type: string;
  reason: RejectReason;
  detail?: string;
}

export interface ParseResult {
  accepted: GraphOperation[];
  rejected: RejectedOperation[];
}

/** Read-only view of current graph state, supplied by the Graph Engine. */
export interface GraphReadView {
  hasNode(id: string): boolean;
  isDescendantOrSelf(maybeDescendant: string, ancestor: string): boolean;
  isOpSeen(opId: string): boolean;
}

export interface ParseMeta {
  /** Id of the LLM response this batch came from; seeds deterministic opIds. */
  responseId: string;
  now: number;
}

function unwrap(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array((raw as { operations?: unknown }).operations)) {
    return (raw as { operations: unknown[] }).operations;
  }
  const ops = (raw as { operations?: unknown } | null)?.operations;
  return Array.isArray(ops) ? ops : [raw];
}

/**
 * Longest title and summary the gate will carry. The prompt asks for ≤14 字 but nothing enforces it,
 * and the node box is CSS-clamped (`.mind-node` is two title lines tall, one summary line), so an
 * over-long string is invisible to the reader while still being re-sent to the model: `capNodes`
 * feeds the last 40 titles and summaries into every MindMap flush prompt, and the same titles into the
 * QA context. These bounds are what make that echo finite. They sit well above what fits on screen so
 * clamping never hides a character the reader could have seen — and truncating is deliberate over
 * rejecting, because dropping the op would lose the concept the sentence was about.
 */
export const MAX_TITLE_CHARS = 40;
export const MAX_SUMMARY_CHARS = 160;

function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The one gate between model output and graph state: schema-validate, then reject operations the
 * graph cannot honour. Rejection is discard+log — an invalid operation must never crash the app.
 *
 * Models do not reliably name a parent before its child, so an operation whose target is only
 * created later in the same response is held back and retried instead of lost (§12 R2, orphan
 * buffer). Passes repeat while any operation newly attaches, so a bottom-up chain still lands.
 */
export function parseGraphOperations(
  raw: unknown,
  ctx: GraphReadView,
  meta: ParseMeta,
): ParseResult {
  const accepted: GraphOperation[] = [];
  const rejected: RejectedOperation[] = [];
  const batchCreated = new Set<string>();
  const batchOpIds = new Set<string>();

  let pending: PendingOp[] = unwrap(raw).map((item, index) => ({ item, index }));
  while (pending.length > 0) {
    const deferred: DeferredOp[] = [];
    for (const entry of pending) {
      const outcome = attemptOperation(entry, ctx, meta, batchCreated, batchOpIds);
      if (outcome.kind === "accepted") accepted.push(outcome.op);
      else if (outcome.kind === "rejected") rejected.push(outcome.rejection);
      else deferred.push({ ...entry, rejection: outcome.rejection });
    }
    // Nothing attached this pass, so the missing ids are not coming: the hold-backs become exactly
    // the rejections they would have been, in their original order.
    if (deferred.length === pending.length) {
      for (const entry of deferred) rejected.push(entry.rejection);
      break;
    }
    pending = deferred;
  }

  return { accepted, rejected };
}

interface PendingOp {
  item: unknown;
  index: number;
}

interface DeferredOp extends PendingOp {
  rejection: RejectedOperation;
}

type Outcome =
  | { kind: "accepted"; op: GraphOperation }
  | { kind: "rejected"; rejection: RejectedOperation }
  | { kind: "deferred"; rejection: RejectedOperation };

/** `deferred` is a not-yet, never a no: the referenced node may still arrive later in this batch. */
function attemptOperation(
  { item, index }: PendingOp,
  ctx: GraphReadView,
  meta: ParseMeta,
  batchCreated: Set<string>,
  batchOpIds: Set<string>,
): Outcome {
  const exists = (id: string) => ctx.hasNode(id) || batchCreated.has(id);
  const fallbackOpId = `${meta.responseId}:${index}`;
  const parsed = GraphOperationInputSchema.safeParse(item);
  if (!parsed.success) {
    const type = (item as { type?: unknown } | null)?.type;
    return {
      kind: "rejected",
      rejection: {
        opId: fallbackOpId,
        type: typeof type === "string" ? type : "unknown",
        reason: "schema",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
    };
  }

  const op = parsed.data;
  const opId = op.opId ?? fallbackOpId;
  if (ctx.isOpSeen(opId) || batchOpIds.has(opId)) {
    return { kind: "rejected", rejection: { opId, type: op.type, reason: "duplicate_op" } };
  }

  switch (op.type) {
    case "add_node": {
      if (exists(op.node.id)) {
        return {
          kind: "rejected",
          rejection: { opId, type: op.type, reason: "duplicate_node_id", detail: op.node.id },
        };
      }
      if (op.node.parentId && !exists(op.node.parentId)) {
        return {
          kind: "deferred",
          rejection: { opId, type: op.type, reason: "orphan_parent", detail: op.node.parentId },
        };
      }
      const node: MindMapNode = {
        id: op.node.id,
        title: clampText(op.node.title, MAX_TITLE_CHARS),
        ...(op.node.summary !== undefined
          ? { summary: clampText(op.node.summary, MAX_SUMMARY_CHARS) }
          : {}),
        ...(op.node.parentId !== undefined ? { parentId: op.node.parentId } : {}),
        sourceTranscriptIds: op.node.sourceTranscriptIds,
        ...(op.node.confidence !== undefined ? { confidence: op.node.confidence } : {}),
        createdAt: meta.now,
        updatedAt: meta.now,
      };
      batchOpIds.add(opId);
      batchCreated.add(node.id);
      return { kind: "accepted", op: { type: "add_node", opId, node } };
    }
    case "update_node": {
      if (!exists(op.nodeId)) {
        return {
          kind: "deferred",
          rejection: { opId, type: op.type, reason: "unknown_node", detail: op.nodeId },
        };
      }
      batchOpIds.add(opId);
      return {
        kind: "accepted",
        op: {
          type: "update_node",
          opId,
          nodeId: op.nodeId,
          patch: {
            ...op.patch,
            ...(op.patch.title !== undefined ? { title: clampText(op.patch.title, MAX_TITLE_CHARS) } : {}),
            ...(op.patch.summary !== undefined ? { summary: clampText(op.patch.summary, MAX_SUMMARY_CHARS) } : {}),
          },
          stampedAt: meta.now,
        },
      };
    }
    case "move_node": {
      if (!exists(op.nodeId) || !exists(op.parentId)) {
        return {
          kind: "deferred",
          rejection: {
            opId,
            type: op.type,
            reason: "unknown_node",
            detail: exists(op.nodeId) ? op.parentId : op.nodeId,
          },
        };
      }
      if (op.nodeId === op.parentId) {
        return { kind: "rejected", rejection: { opId, type: op.type, reason: "self_relation", detail: op.nodeId } };
      }
      if (ctx.isDescendantOrSelf(op.parentId, op.nodeId)) {
        return {
          kind: "rejected",
          rejection: { opId, type: op.type, reason: "cycle", detail: `${op.parentId} under ${op.nodeId}` },
        };
      }
      batchOpIds.add(opId);
      return { kind: "accepted", op: { type: "move_node", opId, nodeId: op.nodeId, parentId: op.parentId, stampedAt: meta.now } };
    }
    case "merge_node": {
      if (!exists(op.sourceNodeId) || !exists(op.targetNodeId)) {
        return {
          kind: "deferred",
          rejection: {
            opId,
            type: op.type,
            reason: "unknown_node",
            detail: exists(op.sourceNodeId) ? op.targetNodeId : op.sourceNodeId,
          },
        };
      }
      if (op.sourceNodeId === op.targetNodeId) {
        return {
          kind: "rejected",
          rejection: { opId, type: op.type, reason: "self_relation", detail: op.sourceNodeId },
        };
      }
      // A merge moves the source's children onto the target, so a target below the source would put
      // them under their own descendant and cut the branch off from every root.
      if (ctx.isDescendantOrSelf(op.targetNodeId, op.sourceNodeId)) {
        return {
          kind: "rejected",
          rejection: { opId, type: op.type, reason: "cycle", detail: `${op.sourceNodeId} into ${op.targetNodeId}` },
        };
      }
      batchOpIds.add(opId);
      return {
        kind: "accepted",
        op: { type: "merge_node", opId, sourceNodeId: op.sourceNodeId, targetNodeId: op.targetNodeId, stampedAt: meta.now },
      };
    }
    case "delete_node": {
      if (!exists(op.nodeId)) {
        return {
          kind: "deferred",
          rejection: { opId, type: op.type, reason: "unknown_node", detail: op.nodeId },
        };
      }
      batchOpIds.add(opId);
      return { kind: "accepted", op: { type: "delete_node", opId, nodeId: op.nodeId } };
    }
    case "add_edge": {
      if (!exists(op.edge.source) || !exists(op.edge.target)) {
        return {
          kind: "deferred",
          rejection: {
            opId,
            type: op.type,
            reason: "unknown_node",
            detail: exists(op.edge.source) ? op.edge.target : op.edge.source,
          },
        };
      }
      if (op.edge.source === op.edge.target) {
        return {
          kind: "rejected",
          rejection: { opId, type: op.type, reason: "self_relation", detail: op.edge.source },
        };
      }
      batchOpIds.add(opId);
      return { kind: "accepted", op: { type: "add_edge", opId, edge: op.edge } };
    }
  }
}
