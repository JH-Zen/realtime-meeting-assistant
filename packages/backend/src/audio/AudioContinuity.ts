import { AudioCaptureSchema, AudioCaptureEndSchema, type AudioCapture, type AudioCaptureEnd, type AudioGapInput, type AudioInputPosition } from "@rcc/shared";

const EPSILON = 0.00001;
interface CaptureState { id: string; origin: number; nextSeq: number; end: number; lost: boolean }

/** Sequence evidence only, never an audio queue or a promise of recognition. */
export class AudioContinuity {
  private active: CaptureState | null = null;
  private cursor = 0;
  private readonly ended = new Set<string>();

  constructor(private readonly sessionId: string, private readonly onGap: (gap: AudioGapInput) => void) {}

  accept(capture: AudioCapture, seq: number, durationSec: number): AudioInputPosition | null {
    if (!AudioCaptureSchema.safeParse(capture).success || capture.sessionId !== this.sessionId ||
      !Number.isSafeInteger(seq) || seq < 0 || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 1 || this.ended.has(capture.captureId)) return null;
    const previous = this.active;
    let state = previous;
    if (previous?.id !== capture.captureId) {
      if (capture.originTime + EPSILON < this.cursor) return null;
      state = { id: capture.captureId, origin: capture.originTime, nextSeq: 0, end: capture.originTime, lost: false };
    }
    if (!state || Math.abs(state.origin - capture.originTime) > EPSILON || seq < state.nextSeq || capture.startTime + EPSILON < state.end) return null;
    if (seq > state.nextSeq && capture.startTime <= state.end + EPSILON) return null;
    // Validate the entire candidate before retiring a working capture. Malformed replacement
    // frames must not make all later frames of the original capture look stale.
    if (previous?.id !== capture.captureId) {
      if (previous?.lost && capture.originTime > previous.end + EPSILON) this.gap(previous.end, capture.originTime, "transport_disconnect", "possible");
      if (previous) this.retire(previous.id);
    }
    if (capture.startTime > state.end + EPSILON) this.gap(state.end, capture.startTime, "sequence_gap", "observed");
    state.nextSeq = seq + 1;
    state.end = capture.startTime + durationSec;
    state.lost = false;
    this.active = state;
    this.cursor = state.end;
    return { captureId: capture.captureId, seq, startTime: capture.startTime, durationSec };
  }

  end(capture: AudioCaptureEnd): boolean {
    if (!AudioCaptureEndSchema.safeParse(capture).success || capture.sessionId !== this.sessionId) return false;
    if (this.ended.has(capture.captureId)) return true;
    let state = this.active;
    if (state?.id !== capture.captureId) {
      if (state || capture.originTime + EPSILON < this.cursor) return false;
      state = { id: capture.captureId, origin: capture.originTime, nextSeq: 0, end: capture.originTime, lost: false };
    }
    if (Math.abs(state.origin - capture.originTime) > EPSILON || capture.nextSeq < state.nextSeq || capture.endTime + EPSILON < state.end) return false;
    if (capture.nextSeq > state.nextSeq && capture.endTime > state.end + EPSILON) this.gap(state.end, capture.endTime, "capture_tail", "observed");
    this.cursor = Math.max(this.cursor, capture.endTime);
    this.retire(capture.captureId);
    this.active = null;
    return true;
  }

  transportLost(_atSec: number): void { if (this.active) this.active.lost = true; }

  finishAt(endSec: number): void {
    const state = this.active;
    if (state?.lost && Number.isFinite(endSec) && endSec > state.end + EPSILON) this.gap(state.end, endSec, "transport_disconnect", "possible");
    if (state) this.retire(state.id);
    this.active = null;
  }

  private retire(id: string): void {
    this.ended.add(id);
    // Old timestamps are refused by cursor even after their identity leaves this bounded cache.
    if (this.ended.size > 64) { const first = this.ended.values().next().value; if (first) this.ended.delete(first); }
  }

  private gap(startTime: number, endTime: number, reason: AudioGapInput["reason"], certainty: AudioGapInput["certainty"]): void {
    this.onGap({ stage: "capture_backend", reason, certainty, startTime, endTime });
  }
}
