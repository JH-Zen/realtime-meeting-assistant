import type { TranscriptSegment } from "@rcc/shared";
import type { STTProvider } from "./STTProvider.js";
import {
  MOCK_PARTIAL_STEPS,
  MOCK_SCRIPT,
  MOCK_SCRIPT_SPAN_SEC,
  mockSegmentId,
} from "../testing/mockScript.js";

/**
 * Emits a partial stream that resolves into a final, exactly like a streaming engine, so the
 * partial-never-persisted rule is exercised in Mock Mode rather than only in Phase 5.
 * Times are speech-relative: `startTime` is seconds since the recording began.
 */
export class MockSTTProvider implements STTProvider {
  readonly name = "mock";
  private partialCallbacks: Array<(segment: TranscriptSegment) => void> = [];
  private finalCallbacks: Array<(segment: TranscriptSegment) => void> = [];
  private timers = new Set<{ remaining: number; due: number; handle: NodeJS.Timeout | null; action: () => void }>();
  private paused = false;
  private connected = false;
  private stopped = false;
  private startedAt = 0;

  constructor(
    private readonly sessionId: string,
    /** 1 = realtime. Raise it in tests to replay the script quickly. */
    private readonly speed = 1,
    /** Passes of the script; `0` runs until `disconnect`. Test F needs tens of minutes of speech. */
    private readonly repeat = 1,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    this.stopped = false;
    this.connected = true;
    this.startedAt = Date.now();
    this.schedulePass(0);
  }

  private schedule(action: () => void, delay: number): void {
    const task = { remaining: delay, due: 0, handle: null as NodeJS.Timeout | null, action };
    this.timers.add(task);
    if (!this.paused) this.arm(task);
  }

  private arm(task: { remaining: number; due: number; handle: NodeJS.Timeout | null; action: () => void }): void {
    task.due = Date.now() + task.remaining;
    task.handle = setTimeout(() => {
      this.timers.delete(task);
      if (!this.stopped && !this.paused) task.action();
    }, task.remaining);
  }

  pause(): void {
    if (this.paused || this.stopped) return;
    this.paused = true;
    for (const task of this.timers) {
      task.remaining = Math.max(0, task.due - Date.now());
      if (task.handle) clearTimeout(task.handle);
      task.handle = null;
    }
  }

  resume(): void {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    for (const task of this.timers) this.arm(task);
  }

  /**
   * One pass scheduled at a time, so an endless recording carries eight live timers instead of the
   * several thousand a 120-minute run would pre-create at connect. Delays are relative to the pass,
   * because a chained pass is only created when that pass begins; the offsets stay in the data.
   */
  private schedulePass(pass: number): void {
    if (this.stopped) return;
    const offset = pass * MOCK_SCRIPT_SPAN_SEC;
    for (const [index, line] of MOCK_SCRIPT.entries()) {
      const segmentIndex = pass * MOCK_SCRIPT.length + index;
      const segmentStart = line.at + offset;
      const segmentEnd = line.at + line.durationSec + offset;
      const id = mockSegmentId(this.sessionId, segmentIndex);
      for (let step = 1; step <= MOCK_PARTIAL_STEPS; step++) {
        const atSec = segmentStart + (step * line.durationSec) / (MOCK_PARTIAL_STEPS + 1);
        const visible = line.text.slice(0, Math.ceil((line.text.length * step) / MOCK_PARTIAL_STEPS));
        this.schedule(() => {
            const partial: TranscriptSegment = {
              id,
              sessionId: this.sessionId,
              text: visible,
              startTime: atSec,
              type: "partial",
              createdAt: this.startedAt + Math.round(atSec * 1000),
            };
            for (const cb of this.partialCallbacks) cb(partial);
          }, ms(atSec - offset, this.speed));
      }
      this.schedule(() => {
          const final: TranscriptSegment = {
            id,
            sessionId: this.sessionId,
            text: line.text,
            startTime: segmentStart,
            endTime: segmentEnd,
            confidence: 0.9,
            type: "final",
            createdAt: this.startedAt + Math.round(segmentEnd * 1000),
          };
          for (const cb of this.finalCallbacks) cb(final);
        }, ms(segmentEnd - offset, this.speed));
    }
    if (this.repeat === 0 || pass + 1 < this.repeat) {
      this.schedule(() => this.schedulePass(pass + 1), ms(MOCK_SCRIPT_SPAN_SEC, this.speed) + 1);
    }
  }

  sendAudio(): void {
    // Mock Mode ignores audio; the script is the input.
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.stopped = true;
    for (const timer of this.timers) if (timer.handle) clearTimeout(timer.handle);
    this.timers.clear();
  }

  onPartial(callback: (segment: TranscriptSegment) => void): void {
    this.partialCallbacks.push(callback);
  }

  onFinal(callback: (segment: TranscriptSegment) => void): void {
    this.finalCallbacks.push(callback);
  }
}

function ms(atSec: number, speed: number): number {
  return Math.max(0, Math.round((atSec * 1000) / speed));
}
