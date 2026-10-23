import { z } from "zod";

/** Times are on the session's active recording timeline, excluding deliberate pauses. */
export const AudioCaptureSchema = z.object({
  sessionId: z.string().min(1).max(128),
  captureId: z.string().min(1).max(128),
  originTime: z.number().finite().min(0),
  startTime: z.number().finite().min(0),
}).refine((value) => value.startTime >= value.originTime, "Audio frame precedes capture origin");
export type AudioCapture = z.infer<typeof AudioCaptureSchema>;

export const AudioCaptureEndSchema = z.object({
  sessionId: z.string().min(1).max(128), captureId: z.string().min(1).max(128),
  originTime: z.number().finite().min(0), endTime: z.number().finite().min(0),
  nextSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).refine((value) => value.endTime >= value.originTime, "Capture end precedes origin");
export type AudioCaptureEnd = z.infer<typeof AudioCaptureEndSchema>;

/** Validated PCM duration is derived by the backend, never trusted from a JSON sample count. */
export interface AudioInputPosition {
  captureId: string;
  seq: number;
  startTime: number;
  durationSec: number;
}

export const AudioGapSchema = z.object({
  id: z.string().min(1).max(256),
  sessionId: z.string().min(1),
  stage: z.enum(["capture_backend", "backend_stt"]),
  reason: z.enum(["sequence_gap", "capture_tail", "transport_disconnect", "worker_unavailable", "worker_disconnect"]),
  certainty: z.enum(["observed", "possible"]),
  startTime: z.number().finite().min(0),
  endTime: z.number().finite().min(0),
  createdAt: z.number().finite(),
}).refine((value) => value.endTime > value.startTime, "Audio gap must have positive duration");
export type AudioGap = z.infer<typeof AudioGapSchema>;
export type AudioGapInput = Omit<AudioGap, "id" | "sessionId" | "createdAt">;
