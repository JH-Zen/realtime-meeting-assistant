import { z } from "zod";

/**
 * Canonical internal protocol. Nothing from a third party (sherpa-onnx frames,
 * LLM JSON, a graph library's node shape) may enter a core module without first
 * being converted into one of these types.
 */

export const TranscriptSegmentSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string(),
  startTime: z.number(),
  endTime: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  type: z.enum(["partial", "final"]),
  createdAt: z.number(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const MindMapNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  parentId: z.string().min(1).optional(),
  sourceTranscriptIds: z.array(z.string().min(1)).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  confidence: z.number().min(0).max(1).optional(),
});
export type MindMapNode = z.infer<typeof MindMapNodeSchema>;

export const MindMapEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.string().min(1).optional(),
});
export type MindMapEdge = z.infer<typeof MindMapEdgeSchema>;

export const SummaryBlockSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  startTime: z.number(),
  endTime: z.number(),
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).default([]),
  entities: z.array(z.string().min(1)).default([]),
  level: z.number().int().min(0).default(0),
  /**
   * Lineage anchor, kept from §31's interface. A merged block summarizes several children, and one
   * id cannot name them — `sourceBlockIds` does; this points at the first of them.
   */
  parentBlockId: z.string().min(1).optional(),
  /** Set only on a merged block: the lower-level blocks it was built from. Never rewritten. */
  sourceBlockIds: z.array(z.string().min(1)).default([]),
});
export type SummaryBlock = z.infer<typeof SummaryBlockSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(["recording", "paused", "completed"]),
});
export type Session = z.infer<typeof SessionSchema>;

/** Transcript is the system's single source of truth; this is the store's contract. */
export interface TranscriptStore {
  /** Only `final` segments may be persisted. Partials are display-only. */
  appendFinal(segment: TranscriptSegment): void;
  listFinal(sessionId: string): TranscriptSegment[];
  /** Segment ids are unique inside a session, never across sessions. */
  getFinal(sessionId: string, id: string): TranscriptSegment | undefined;
}
