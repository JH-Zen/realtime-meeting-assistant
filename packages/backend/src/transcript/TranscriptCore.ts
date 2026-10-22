import { TranscriptSegmentSchema, type TranscriptSegment, type TranscriptStore } from "@rcc/shared";
import type { AppBus } from "../bus/eventBus.js";
import { log } from "../observability/log.js";

/**
 * Transcript Core: the only place STT output becomes durable knowledge.
 *
 * Partials go to a bounded display buffer and the bus — never to SQLite, the MindMap buffer,
 * Memory or embeddings. Finals are validated, de-duplicated by id, persisted, then published.
 */
export class TranscriptCore {
  private readonly partials = new Map<string, TranscriptSegment>();
  /**
   * Every final id of the session, deliberately unbounded: `count()` reports through it, and a capped
   * dedup set would let a very old id be inserted twice. At a final per sentence, this is a few
   * thousand short strings for a two-hour talk.
   */
  private readonly seenFinalIds = new Set<string>();
  /** Ring buffer of recent finals; the MindMap agent reads its window from here, not from SQLite. */
  private readonly recentFinals: TranscriptSegment[] = [];
  private readonly recentCapacity = 400;
  /**
   * Partials are only ever evicted by the final that supersedes them, and a socket that drops
   * mid-utterance never delivers one. The buffer is display-only, so an unreferenced line is dropped
   * rather than held for the rest of a two-hour talk.
   */
  private readonly partialCapacity = 32;

  constructor(
    private readonly bus: AppBus,
    private readonly store: TranscriptStore,
  ) {}

  acceptPartial(segment: TranscriptSegment): void {
    const parsed = TranscriptSegmentSchema.safeParse(segment);
    if (!parsed.success || parsed.data.type !== "partial") return;
    this.partials.set(parsed.data.id, parsed.data);
    while (this.partials.size > this.partialCapacity) {
      const oldest = this.partials.keys().next().value;
      if (oldest === undefined) break;
      this.partials.delete(oldest);
    }
    this.bus.emit("transcript.partial", parsed.data);
  }

  acceptFinal(segment: TranscriptSegment): void {
    const parsed = TranscriptSegmentSchema.safeParse(segment);
    if (!parsed.success || parsed.data.type !== "final") return;
    const final = parsed.data;
    if (this.seenFinalIds.has(final.id)) return;

    // The durable write decides everything after it, and it must not throw: this method is called
    // from the STT provider's socket callback, where nothing catches, so one SQLite error would be an
    // uncaught exception and end the recording. The id also stays unburned on failure — a sentence
    // that was never stored must remain eligible for the redelivery that follows.
    try {
      this.store.appendFinal(final);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("final segment not persisted", { sessionId: final.sessionId, id: final.id, message });
      this.bus.emit("module.error", {
        module: "transcript",
        code: "append_failed",
        message,
        at: Date.now(),
        recoverable: true,
      });
      return;
    }

    this.seenFinalIds.add(final.id);
    this.partials.delete(final.id);
    this.recentFinals.push(final);
    if (this.recentFinals.length > this.recentCapacity) this.recentFinals.shift();
    this.bus.emit("transcript.final", final);
  }

  /** Current on-screen text for a segment id, superseded once the final lands. */
  getPartial(id: string): TranscriptSegment | undefined {
    return this.partials.get(id);
  }

  /**
   * Finals whose speech falls inside `[endSec - windowSec, endSec]`. Used as the MindMap agent's
   * short-term window and as Hot Context for questions.
   */
  window(sessionId: string, windowSec: number): TranscriptSegment[] {
    if (windowSec <= 0) return [];
    const cutoff = (this.lastSpeechSec() ?? 0) - windowSec;
    return this.recentFinals.filter((segment) => segment.sessionId === sessionId && segment.startTime >= cutoff);
  }

  /** Durable history for a session, read from the store rather than the in-memory window. */
  allFinals(sessionId: string): TranscriptSegment[] {
    return this.store.listFinal(sessionId);
  }

  lastSpeechSec(): number | undefined {
    const last = this.recentFinals.at(-1);
    return last?.endTime ?? last?.startTime;
  }

  count(): number {
    return this.seenFinalIds.size;
  }

  /** Restores state after a restart so a crash does not silently truncate Hot Context. */
  prime(segments: TranscriptSegment[]): void {
    for (const segment of segments) {
      if (this.seenFinalIds.has(segment.id)) continue;
      this.seenFinalIds.add(segment.id);
      this.recentFinals.push(segment);
    }
    if (this.recentFinals.length > this.recentCapacity) {
      this.recentFinals.splice(0, this.recentFinals.length - this.recentCapacity);
    }
  }
}
