import { randomUUID } from "node:crypto";
import type { Session } from "@rcc/shared";
import type { AppBus } from "../bus/eventBus.js";
import type { SqliteSessionRepository } from "../store/sessionRepository.js";
import type { SessionRuntime } from "../runtime/SessionRuntime.js";

/**
 * Owns the recording lifecycle and the speech clock. Pause is a publish gate, not a process gate —
 * the bus, stores and other modules keep running. A provider failure becomes `module.error`, so the
 * UI can show "STT failed" while the session survives (§44, Test E).
 */
export class RecordingController {
  private runtime: SessionRuntime | null = null;
  private paused = false;
  /** The runtime is a history opened from a file, not a recording this process owns. */
  private viewing = false;
  /** Speech time accumulated before the current running span. */
  private accumulatedSec = 0;
  private spanStartedAt = 0;

  constructor(
    private readonly bus: AppBus,
    private readonly sessions: SqliteSessionRepository,
    private readonly createRuntime: (session: Session) => SessionRuntime,
  ) {}

  get current(): SessionRuntime | null {
    return this.runtime;
  }

  get sessionId(): string | null {
    return this.runtime?.session.id ?? null;
  }

  get state(): "idle" | "recording" | "paused" | "viewing" {
    if (!this.runtime) return "idle";
    if (this.viewing) return "viewing";
    return this.paused ? "paused" : "recording";
  }

  elapsedSec(): number {
    if (this.viewing && this.runtime) {
      // The clock of a history is the talk's own length, not time since it was opened.
      const { startedAt, endedAt } = this.runtime.session;
      return Math.max(0, ((endedAt ?? Date.now()) - startedAt) / 1000);
    }
    if (!this.runtime || this.spanStartedAt === 0) return this.accumulatedSec;
    return this.accumulatedSec + (Date.now() - this.spanStartedAt) / 1000;
  }

  /**
   * Put a finished session on the live surface with nothing attached to it (§13 OPEN-10: an imported
   * session must be readable *and* askable). `SessionRuntime` hydrates the graph from the store in its
   * constructor, so the two starts below are all the viewing mode needs: Memory reads the overview out
   * of `summary_blocks`, and Retrieval answers out of the index the import rebuilt.
   *
   * `mindmap.start()` is deliberately absent. Nothing may write into a session whose recording is
   * over — the same rule that made D-31 discard a late response — and a map agent subscribed to the
   * bus would be a second writer to a tree the user can only read.
   *
   * `false` while a recording is live: opening a file must never end the user's recording for them.
   */
  openHistory(session: Session): boolean {
    if (this.runtime && !this.viewing) return false;
    this.runtime?.dispose();
    const runtime = this.createRuntime(session);
    runtime.memory.start();
    runtime.retrieval.start();
    this.runtime = runtime;
    this.viewing = true;
    this.paused = false;
    this.spanStartedAt = 0;
    this.accumulatedSec = 0;
    return true;
  }

  async start(source: "mic" | "mock"): Promise<string> {
    if (this.viewing) {
      // Reading a history is not work at risk: the file it came from is already saved, and the rows
      // are in the store. Stopping a recording, by contrast, has to run the full drain below.
      this.runtime?.dispose();
      this.runtime = null;
      this.viewing = false;
    } else if (this.runtime) await this.stop();

    const session: Session = { id: randomUUID(), startedAt: Date.now(), status: "recording" };
    this.sessions.create(session);
    const runtime = this.createRuntime(session);
    this.runtime = runtime;
    this.viewing = false;
    this.paused = false;
    this.accumulatedSec = 0;
    this.spanStartedAt = Date.now();

    this.bus.emit("recording.started", { sessionId: session.id, at: Date.now(), source });
    await runtime.attach(source);
    runtime.mindmap.start();
    runtime.memory.start();
    runtime.retrieval.start();
    return session.id;
  }

  pause(): void {
    if (!this.runtime || this.paused || this.viewing) return;
    this.accumulatedSec = this.elapsedSec();
    this.spanStartedAt = 0;
    this.paused = true;
    this.sessions.setStatus(this.runtime.session.id, "paused");
    this.bus.emit("recording.paused", {
      sessionId: this.runtime.session.id,
      state: "paused",
      elapsedSec: this.accumulatedSec,
    });
  }

  resume(): void {
    if (!this.runtime || !this.paused || this.viewing) return;
    this.paused = false;
    this.spanStartedAt = Date.now();
    this.sessions.setStatus(this.runtime.session.id, "recording");
    this.bus.emit("recording.resumed", {
      sessionId: this.runtime.session.id,
      state: "recording",
      elapsedSec: this.accumulatedSec,
    });
  }

  async stop(): Promise<void> {
    if (this.viewing) {
      // Nothing to drain and no recogniser to close, and emitting `recording.stopped` would tell every
      // client that a recording finished when none had started.
      this.runtime?.dispose();
      this.runtime = null;
      this.viewing = false;
      return;
    }
    const runtime = this.runtime;
    if (!runtime) return;
    const durationSec = this.elapsedSec();
    this.accumulatedSec = durationSec;
    this.spanStartedAt = 0;
    this.paused = true;
    this.runtime = null;

    // Drain in this order. `detach()` is what lets the recogniser finish the audio it already holds,
    // and the finals it emits during that window are exactly the lines the flushes below would miss —
    // so every module keeps its listener until the source is silent, takes what arrived, and only then
    // stops. Flushing first, as this used to, persisted the last sentences as transcript and left them
    // out of the map, the summaries and the index.
    await runtime.detach();
    // The tail of a talk rarely reaches the segment threshold, so without these the last few finals
    // would be stored but never folded into the tree or the index. `flush()` is unconditional and
    // waits for the request already in flight: an answer that arrives after `mindmap.stop()` is
    // discarded, so a `pendingCount > 0` guard here would lose the batch the model is still working
    // on — which is the usual case, since the recogniser closes in milliseconds and the LLM in seconds.
    await runtime.mindmap.flush();
    await runtime.memory.flushRemaining();
    await runtime.retrieval.flushPending();
    runtime.mindmap.stop();
    runtime.memory.stop();
    runtime.retrieval.stop();
    this.sessions.setStatus(runtime.session.id, "completed", Date.now());
    this.bus.emit("recording.stopped", {
      sessionId: runtime.session.id,
      at: Date.now(),
      segmentCount: runtime.transcript.count(),
      durationSec,
    });
    runtime.dispose();
  }

  provideAudio(chunk: ArrayBuffer): void {
    if (!this.runtime || this.paused || this.viewing) return;
    this.runtime.sendAudio(chunk);
  }
}
