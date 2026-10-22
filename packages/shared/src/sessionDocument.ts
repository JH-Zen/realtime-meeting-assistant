import { z } from "zod";
import {
  MindMapEdgeSchema,
  MindMapNodeSchema,
  SessionSchema,
  SummaryBlockSchema,
  TranscriptSegmentSchema,
} from "./types.js";

/**
 * The single-session export/import contract (§13 OPEN-10, decided 2026-10-21: structured import and
 * export of one session, and an imported session must be askable).
 *
 * Two things are deliberately **not** in the file:
 *  - Embedding vectors. They are float32 little-endian BLOBs derived from text by whichever provider
 *    is configured (`retrieval/vector.ts`), and a "structured" document that is half base64 stops
 *    being inspectable. Import recomputes them through the existing retrieval path instead.
 *  - `graph_operations`. That table is an audit log of what the model proposed, not state; replaying
 *    it would re-run decisions the document already carries as their result.
 */

export const SESSION_DOCUMENT_SCHEMA_VERSION = 1;

export const CitationSchema = z.object({
  transcriptId: z.string().min(1),
  startTime: z.number(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ExportQuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.number(),
  /** Kept for auditability even though `ContextSnapshot` itself is never persisted (OPEN-10 ⑤). */
  snapshotId: z.string().default(""),
});
export type ExportQuestion = z.infer<typeof ExportQuestionSchema>;

export const ExportAnswerSchema = z.object({
  questionId: z.string().min(1),
  text: z.string(),
  citations: z.array(CitationSchema).default([]),
  durationMs: z.number().min(0).default(0),
  degraded: z.boolean().default(false),
  createdAt: z.number(),
});
export type ExportAnswer = z.infer<typeof ExportAnswerSchema>;

export const ExportPointSchema = z.object({ x: z.number(), y: z.number() });

export const SessionExchangeSchema = z.object({
  question: ExportQuestionSchema,
  /** `null` when the question was admitted but nothing answered it. */
  answer: ExportAnswerSchema.nullable(),
});

export const SessionDocumentSchema = z.object({
  schemaVersion: z.literal(SESSION_DOCUMENT_SCHEMA_VERSION),
  exportedAt: z.number(),
  session: SessionSchema,
  transcripts: z.array(TranscriptSegmentSchema),
  nodes: z.array(MindMapNodeSchema),
  edges: z.array(MindMapEdgeSchema).default([]),
  /** Dragged positions only, matching the wire convention in `pinnedPositions()` — a layout-derived
   *  coordinate is re-derived on open and must not be frozen into the file. */
  positions: z.record(z.string(), ExportPointSchema).default({}),
  summaries: z.array(SummaryBlockSchema).default([]),
  exchanges: z.array(SessionExchangeSchema).default([]),
});
export type SessionDocument = z.infer<typeof SessionDocumentSchema>;

/**
 * Shape-level zod cannot express the things that make an imported session *coherent*, and each rule
 * below exists because breaking it fails silently: a node whose parent is missing is not an error at
 * write time, it is a branch nobody can reach, which is how D-31 lost whole batches to the gate.
 */
export function sessionDocumentIssues(document: SessionDocument): string[] {
  const issues: string[] = [];
  const { session, nodes, edges, transcripts, summaries, exchanges } = document;

  const checkUnique = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) issues.push(`${label}: duplicate id "${id}"`);
      seen.add(id);
    }
  };
  checkUnique("nodes", nodes.map((node) => node.id));
  checkUnique("edges", edges.map((edge) => edge.id));
  checkUnique("transcripts", transcripts.map((segment) => segment.id));
  checkUnique("summaries", summaries.map((block) => block.id));
  checkUnique("questions", exchanges.map((entry) => entry.question.id));

  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    if (node.parentId !== undefined && !nodeIds.has(node.parentId)) {
      issues.push(`node "${node.id}": parentId "${node.parentId}" is not in this document`);
    }
  }
  // A parent cycle has no entry point, so every node in it is unreachable and none is an error until
  // something tries to draw it. Walk up with a seen-set rather than trusting the depth to terminate.
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  for (const node of nodes) {
    const chain = new Set<string>([node.id]);
    let cursor = node.parentId;
    while (cursor !== undefined) {
      if (chain.has(cursor)) {
        issues.push(`node "${node.id}": parentId chain loops back on "${cursor}"`);
        break;
      }
      chain.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push(`edge "${edge.id}" refers to a node that is not in this document`);
    }
  }

  for (const entry of exchanges) {
    if (entry.answer && entry.answer.questionId !== entry.question.id) {
      issues.push(
        `question "${entry.question.id}": answer carries questionId "${entry.answer.questionId}", ` +
          `but answers.id == questions.id is an invariant of the store`,
      );
    }
  }

  // One file, one session. A document assembled from two sessions would import as one and make the
  // provenance of every node unreadable afterwards.
  const foreign = [
    ...transcripts.filter((segment) => segment.sessionId !== session.id).map(() => "transcripts"),
    ...summaries.filter((block) => block.sessionId !== session.id).map(() => "summaries"),
  ];
  for (const label of new Set(foreign)) {
    issues.push(`${label}: rows from a session other than "${session.id}" cannot be part of this document`);
  }

  return issues;
}

export interface SessionDocumentParseResult {
  document?: SessionDocument;
  issues: string[];
}

/** `safeParse` plus the coherence rules, so callers get one list of reasons either way. */
export function parseSessionDocument(raw: unknown): SessionDocumentParseResult {
  const parsed = SessionDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return { document: parsed.data, issues: sessionDocumentIssues(parsed.data) };
}
