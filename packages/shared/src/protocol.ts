import { z } from "zod";
import {
  AnswerCompletedSchema,
  AnswerRejectedSchema,
  AnswerStartedSchema,
  AnswerTokenSchema,
  MindMapSkippedSchema,
  MindMapUpdatedSchema,
  ModuleErrorSchema,
  RecordingChangedSchema,
  RecordingStartedSchema,
  RecordingStoppedSchema,
  SttConnectionSchema,
  SttStatusSchema,
  SummaryUpdatedSchema,
} from "./events.js";
import { MindMapEdgeSchema, MindMapNodeSchema, SessionSchema, TranscriptSegmentSchema } from "./types.js";
import { SessionExchangeSchema } from "./sessionDocument.js";
import { AudioCaptureSchema, AudioCaptureEndSchema } from "./audio.js";

/**
 * The WebSocket wire protocol between backend and frontend. Server events are the same objects
 * the in-process bus carries, so a client is just another subscriber — no second vocabulary.
 */

export const ServerEventSchema = z.discriminatedUnion("kind", [
  // `sessionId` is absent before the first recording; the frame must still validate so a client
  // that connects while the server is idle can tell "idle" from "unreadable".
  z.object({
    kind: z.literal("session.snapshot"),
    sessionId: z.string().min(1).optional(),
    session: SessionSchema.optional(),
    /**
     * `viewing` is a history opened from an exported file: readable and askable, but no capture is
     * attached and the record buttons must not offer to continue it (§13 OPEN-10). It is a state and
     * not a flag beside the state because every consumer that gates on "is anything live" is exactly
     * the consumer that must also gate on "is this mine to write into".
     */
    state: z.enum(["idle", "recording", "paused", "viewing"]),
    elapsedSec: z.number(),
    /** Identifies the recognition engine state as state rather than only as an event. */
    stt: SttConnectionSchema,
    serverTime: z.number(),
  }),
  z.object({
    kind: z.literal("graph.snapshot"),
    sessionId: z.string().min(1),
    nodes: z.array(MindMapNodeSchema),
    edges: z.array(MindMapEdgeSchema),
    /**
     * Coordinates the user dragged a node to, so a reconnect or reload lands on the same map instead
     * of a fresh layout (Test B). Only drags are stored: everything else the client can re-derive
     * deterministically from the operations, and a re-derived position must stay free to move when the
     * model inserts a branch.
     */
    positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
  }),
  z.object({ kind: z.literal("transcript.snapshot"), sessionId: z.string().min(1), segments: z.array(TranscriptSegmentSchema) }),
  z.object({
    kind: z.literal("answers.snapshot"),
    sessionId: z.string().min(1),
    exchanges: z.array(SessionExchangeSchema),
    pendingQuestionIds: z.array(z.string()).default([]),
  }),
  z.object({ kind: z.literal("transcript.partial"), segment: TranscriptSegmentSchema }),
  z.object({ kind: z.literal("transcript.final"), segment: TranscriptSegmentSchema }),
  z.object({ kind: z.literal("recording.started"), ...RecordingStartedSchema.shape }),
  z.object({ kind: z.literal("recording.paused"), ...RecordingChangedSchema.shape }),
  z.object({ kind: z.literal("recording.resumed"), ...RecordingChangedSchema.shape }),
  z.object({ kind: z.literal("recording.stopped"), ...RecordingStoppedSchema.shape }),
  z.object({ kind: z.literal("stt.status"), ...SttStatusSchema.shape }),
  z.object({ kind: z.literal("mindmap.updated"), ...MindMapUpdatedSchema.shape }),
  z.object({ kind: z.literal("mindmap.node.upserted"), node: MindMapNodeSchema }),
  z.object({ kind: z.literal("mindmap.skipped"), ...MindMapSkippedSchema.shape }),
  z.object({ kind: z.literal("summary.updated"), ...SummaryUpdatedSchema.shape }),
  z.object({ kind: z.literal("answer.started"), ...AnswerStartedSchema.shape }),
  z.object({ kind: z.literal("answer.token"), ...AnswerTokenSchema.shape }),
  z.object({ kind: z.literal("answer.completed"), ...AnswerCompletedSchema.shape }),
  z.object({ kind: z.literal("answer.rejected"), ...AnswerRejectedSchema.shape }),
  z.object({ kind: z.literal("module.error"), ...ModuleErrorSchema.shape }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export const ClientCommandSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("recording.start"), source: z.enum(["mic", "mock"]).default("mock") }),
  z.object({ cmd: z.literal("recording.pause") }),
  z.object({ cmd: z.literal("recording.resume") }),
  z.object({ cmd: z.literal("recording.stop") }),
  z.object({ cmd: z.literal("session.close") }),
  z.object({ cmd: z.literal("audio.chunk"), seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), pcmBase64: z.string().max(128_000), capture: AudioCaptureSchema.optional() }),
  z.object({ cmd: z.literal("audio.capture.end"), capture: AudioCaptureEndSchema }),
  z.object({
    cmd: z.literal("question.ask"),
    sessionId: z.string().min(1).optional(),
    questionId: z.string().min(1),
    text: z.string().min(1).max(4000),
  }),
  z.object({ cmd: z.literal("mindmap.forceUpdate") }),
  z.object({
    cmd: z.literal("mindmap.node.moved"),
    nodeId: z.string().min(1),
    /** Dragged-to coordinates in layout space, sent on drag end only — never during the drag. */
    x: z.number(),
    y: z.number(),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export function encodeServerEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

/** Frames that fail validation are dropped, never applied — the client cannot steer the graph. */
export function decodeServerEvent(raw: string): ServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ServerEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function decodeClientCommand(raw: string): ClientCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ClientCommandSchema.safeParse(value);
  return result.success ? result.data : null;
}
