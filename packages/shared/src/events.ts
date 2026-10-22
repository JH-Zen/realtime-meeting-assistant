import { z } from "zod";
import {
  SummaryBlockSchema,
  type MindMapNode,
  type TranscriptSegment,
} from "./types.js";
import { GraphOperationSchema } from "./graph.js";

/**
 * Canonical event contract (design doc §17). Cross-module signalling only travels through these
 * names; `module.error` is the fault-boundary escape hatch — a failing module reports here and
 * nothing else is allowed to stop.
 */

export const ModuleIdSchema = z.enum([
  "stt",
  "transcript",
  "mindmap",
  "memory",
  "retrieval",
  "qa",
  "ui",
  "bus",
]);
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export const ModuleErrorSchema = z.object({
  module: ModuleIdSchema,
  /** Machine-readable cause key, stable enough to switch on. */
  code: z.string().min(1),
  message: z.string(),
  at: z.number(),
  recoverable: z.boolean().default(true),
});
export type ModuleError = z.infer<typeof ModuleErrorSchema>;

export const RecordingStateSchema = z.enum(["recording", "paused", "stopped"]);
export type RecordingState = z.infer<typeof RecordingStateSchema>;

export const SttConnectionSchema = z.enum(["idle", "connected", "reconnecting", "failed"]);
export type SttConnection = z.infer<typeof SttConnectionSchema>;

export const RecordingStartedSchema = z.object({
  sessionId: z.string().min(1),
  at: z.number(),
  source: z.enum(["mic", "mock"]),
});

export const RecordingChangedSchema = z.object({
  sessionId: z.string().min(1),
  state: RecordingStateSchema,
  /** Elapsed speech time in seconds, excluding paused spans. */
  elapsedSec: z.number().min(0),
});

export const RecordingStoppedSchema = z.object({
  sessionId: z.string().min(1),
  at: z.number(),
  segmentCount: z.number().int().min(0),
  durationSec: z.number().min(0),
});

export const SttStatusSchema = z.object({
  sessionId: z.string().min(1),
  state: SttConnectionSchema,
  attempts: z.number().int().min(0).default(0),
  message: z.string().optional(),
});

export const MindMapUpdateRequestedSchema = z.object({
  sessionId: z.string().min(1),
  /** Final segments folded into this update. Never partials. */
  segmentIds: z.array(z.string().min(1)).min(1),
  reason: z.enum(["batch", "interval", "manual"]),
});

export const MindMapUpdatedSchema = z.object({
  sessionId: z.string().min(1),
  responseId: z.string().min(1),
  operations: z.array(GraphOperationSchema),
  /** Touched ids let the UI lay out a subtree instead of the whole graph. */
  touchedNodeIds: z.array(z.string()),
  durationMs: z.number().min(0),
});

export const MindMapSkippedSchema = z.object({
  sessionId: z.string().min(1),
  /** Single-flight: a request was in flight, so this batch folded into the next buffer. */
  bufferedSegmentCount: z.number().int().min(0),
});

export const SummaryUpdatedSchema = z.object({
  sessionId: z.string().min(1),
  block: SummaryBlockSchema,
});

export const QuestionCreatedSchema = z.object({
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.number(),
});

export const AnswerStartedSchema = z.object({
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  /** Snapshot id proves this answer's context cannot mutate mid-flight (§32). */
  snapshotId: z.string().min(1),
  startedAt: z.number(),
});

export const AnswerTokenSchema = z.object({
  questionId: z.string().min(1),
  /** Accumulated text so far; the client renders the delta itself. */
  text: z.string(),
  ttftMs: z.number().min(0).optional(),
});

export const AnswerCompletedSchema = z.object({
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  text: z.string(),
  citations: z
    .array(z.object({ transcriptId: z.string().min(1), startTime: z.number() }))
    .default([]),
  durationMs: z.number().min(0),
  degraded: z.boolean().default(false),
});

/**
 * Admission control said "no" to this question, so the client may stop waiting. A rejected question
 * must close its own loop (§44): `module.error` is for faults, and a deliberate refusal is not one.
 */
export const AnswerRejectedSchema = z.object({
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  /** `busy` = every answer slot is taken, `rate_limited` = asked again before the interval elapsed. */
  reason: z.enum(["busy", "rate_limited"]),
  message: z.string(),
  /** `0` means "a slot will free, we cannot say when" — an interval refusal carries a real number. */
  retryAfterMs: z.number().min(0).default(0),
});

export type RecordingStarted = z.infer<typeof RecordingStartedSchema>;
export type RecordingChanged = z.infer<typeof RecordingChangedSchema>;
export type RecordingStopped = z.infer<typeof RecordingStoppedSchema>;
export type SttStatus = z.infer<typeof SttStatusSchema>;
export type MindMapUpdateRequested = z.infer<typeof MindMapUpdateRequestedSchema>;
export type MindMapUpdated = z.infer<typeof MindMapUpdatedSchema>;
export type MindMapSkipped = z.infer<typeof MindMapSkippedSchema>;
export type SummaryUpdated = z.infer<typeof SummaryUpdatedSchema>;
export type QuestionCreated = z.infer<typeof QuestionCreatedSchema>;
export type AnswerStarted = z.infer<typeof AnswerStartedSchema>;
export type AnswerToken = z.infer<typeof AnswerTokenSchema>;
export type AnswerCompleted = z.infer<typeof AnswerCompletedSchema>;
export type AnswerRejected = z.infer<typeof AnswerRejectedSchema>;

/**
 * The bus map. `transcript.partial` exists for subtitles only: it is never persisted and never
 * reaches MindMap, Memory or Embedding.
 */
export interface BusEvents {
  "recording.started": [RecordingStarted];
  "recording.paused": [RecordingChanged];
  "recording.resumed": [RecordingChanged];
  "recording.stopped": [RecordingStopped];

  "stt.status": [SttStatus];
  "transcript.partial": [TranscriptSegment];
  "transcript.final": [TranscriptSegment];

  "mindmap.update.requested": [MindMapUpdateRequested];
  "mindmap.updated": [MindMapUpdated];
  "mindmap.skipped": [MindMapSkipped];
  "mindmap.node.upserted": [MindMapNode];

  "summary.updated": [SummaryUpdated];

  "question.created": [QuestionCreated];
  "answer.started": [AnswerStarted];
  "answer.token": [AnswerToken];
  "answer.completed": [AnswerCompleted];
  "answer.rejected": [AnswerRejected];

  "module.error": [ModuleError];
}

export type BusEventName = keyof BusEvents;
