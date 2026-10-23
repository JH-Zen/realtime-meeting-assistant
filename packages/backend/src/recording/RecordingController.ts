import { randomUUID } from "node:crypto";
import type { AudioCapture, AudioCaptureEnd, Session } from "@rcc/shared";
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
  /** A readable session with no attached input (finished here, imported, or reopened). */
  private viewing = false;
  /** Speech time accumulated before the current running span. */
  private accumulatedSec = 0;
  private spanStartedAt = 0;
  private generation = 0;
  private transitions: Promise<void> = Promise.resolve();
  private queued = 0;
  private ending = false;

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

  get transitioning(): boolean { return this.queued > 0; }
  get selectionVersion(): number { return this.generation; }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const result = this.transitions.then(operation);
    this.transitions = result.then(() => { this.queued -= 1; }, () => { this.queued -= 1; });
    return result;
  }

  get state(): "idle" | "recording" | "paused" | "viewing" {
    if (!this.runtime) return "idle";
    if (this.viewing) return "viewing";
    return this.paused ? "paused" : "recording";
  }

  elapsedSec(): number {
    if (this.viewing && this.runtime) {
      // The clock of a history is the talk's own length, not time since it was opened.
      const { durationSec, startedAt, endedAt } = this.runtime.session;
      return durationSec ?? (endedAt === undefined
        ? (this.runtime.transcript.lastSpeechSec() ?? 0)
        : Math.max(0, (endedAt - startedAt) / 1000));
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
  openHistory(session: Session, expectedVersion = this.generation): boolean {
    if (expectedVersion !== this.generation) return false;
    if (this.transitioning || (this.runtime && !this.viewing)) return false;
    const runtime = this.createRuntime(session);
    runtime.memory.start();
    runtime.retrieval.start();
    this.sessions.select(session.id);
    this.runtime?.dispose();
    this.runtime = runtime;
    ++this.generation;
    this.viewing = true;
    this.paused = false;
    this.spanStartedAt = 0;
    this.accumulatedSec = 0;
    this.bus.emit("session.changed", { sessionId: session.id });
    return true;
  }

  /** A restart restores only saved text/graph/answers. It never reopens a microphone or a worker. */
  restoreSelected(): boolean {
    const session = this.sessions.selected();
    return session ? this.openHistory(session) : false;
  }

  start(source: "mic" | "mock"): Promise<string> {
    const generation = ++this.generation;
    this.runtime?.cancelPendingAttach();
    return this.enqueue(async () => {
      if (generation !== this.generation) return "";
      await this.stopCurrent();
      if (generation !== this.generation) return "";
      return this.startCurrent(source, generation);
    });
  }

  private async startCurrent(source: "mic" | "mock", generation: number): Promise<string> {
    const session: Session = { id: randomUUID(), startedAt: Date.now(), status: "recording" };
    this.sessions.create(session);
    const runtime = this.createRuntime(session);
    this.runtime = runtime;
    this.sessions.select(session.id);
    this.viewing = false;
    this.paused = false;
    this.accumulatedSec = 0;
    this.spanStartedAt = Date.now();

    // Subscribe before the worker can send a ready + final in the same network batch. Nothing after
    // the asynchronous handshake is allowed to restart agents belonging to an ended generation.
    runtime.mindmap.start();
    runtime.memory.start();
    runtime.retrieval.start();
    this.bus.emit("recording.started", { sessionId: session.id, at: Date.now(), source });
    await runtime.attach(source);
    if (generation !== this.generation || this.runtime !== runtime) await runtime.detach();
    return session.id;
  }

  pause(): void {
    if (!this.runtime || this.paused || this.viewing || this.ending) return;
    this.accumulatedSec = this.elapsedSec();
    this.spanStartedAt = 0;
    this.paused = true;
    this.runtime.pauseInput();
    this.sessions.setStatus(this.runtime.session.id, "paused");
    this.runtime.session.status = "paused";
    this.bus.emit("recording.paused", {
      sessionId: this.runtime.session.id,
      state: "paused",
      elapsedSec: this.accumulatedSec,
    });
  }

  resume(): void {
    if (!this.runtime || !this.paused || this.viewing || this.ending) return;
    this.paused = false;
    this.runtime.resumeInput();
    this.spanStartedAt = Date.now();
    this.sessions.setStatus(this.runtime.session.id, "recording");
    this.runtime.session.status = "recording";
    this.bus.emit("recording.resumed", {
      sessionId: this.runtime.session.id,
      state: "recording",
      elapsedSec: this.accumulatedSec,
    });
  }

  stop(): Promise<void> {
    ++this.generation;
    // Cancellation is immediate, rather than queued behind the handshake being cancelled.
    this.runtime?.cancelPendingAttach();
    return this.enqueue(() => this.stopCurrent());
  }

  /** End input, drain accepted audio, and keep the same QA runtime available for review. */
  finish(): Promise<void> {
    ++this.generation;
    this.runtime?.cancelPendingAttach();
    return this.enqueue(() => this.stopCurrent(true));
  }

  /** Explicitly leave the meeting. Application shutdown uses stop() to retain restart selection. */
  closeSession(): Promise<void> {
    ++this.generation;
    this.runtime?.cancelPendingAttach();
    return this.enqueue(async () => {
      await this.stopCurrent();
      this.sessions.select(null);
      this.accumulatedSec = 0;
      this.bus.emit("session.changed", { sessionId: null });
    });
  }

  private async stopCurrent(keepSession = false): Promise<void> {
    if (this.viewing) {
      if (keepSession) return;
      // Nothing to drain and no recogniser to close, and emitting `recording.stopped` would tell every
      // client that a recording finished when none had started.
      this.runtime?.dispose();
      this.runtime = null;
      this.viewing = false;
      return;
    }
    const runtime = this.runtime;
    if (!runtime) return;
    this.ending = true;
    const durationSec = this.elapsedSec();
    runtime.audio.finishAt(durationSec);
    this.accumulatedSec = durationSec;
    this.spanStartedAt = 0;
    this.paused = true;
    if (!keepSession) this.runtime = null;

    // Drain in this order. `detach()` is what lets the recogniser finish the audio it already holds,
    // and the finals it emits during that window are exactly the lines the flushes below would miss —
    // so every module keeps its listener until the source is silent, takes what arrived, and only then
    // stops. Flushing first, as this used to, persisted the last sentences as transcript and left them
    // out of the map, the summaries and the index.
    try {
      await runtime.detach();
      // The tail of a talk rarely reaches the segment threshold, so without these the last few finals
      // would be stored but never folded into the tree or the index. `flush()` is unconditional and
      // waits for the request already in flight: an answer that arrives after `mindmap.stop()` is
      // discarded, so a `pendingCount > 0` guard here would lose the batch the model is still working
      // on — which is the usual case, since the recogniser closes in milliseconds and the LLM in seconds.
      await runtime.mindmap.flush();
      await runtime.memory.flushRemaining();
      await runtime.retrieval.flushPending();
    } finally {
      const endedAt = Date.now();
      this.ending = false;
      runtime.session.status = "completed";
      runtime.session.endedAt = endedAt;
      runtime.session.durationSec = durationSec;
      this.sessions.setStatus(runtime.session.id, "completed", endedAt, durationSec);
      if (keepSession) {
        runtime.mindmap.pauseLive();
        this.viewing = true;
        this.paused = false;
      } else runtime.dispose();
      this.bus.emit("recording.stopped", {
        sessionId: runtime.session.id,
        at: Date.now(),
        segmentCount: runtime.transcript.count(),
        durationSec,
      });
      if (keepSession) this.bus.emit("session.changed", { sessionId: runtime.session.id });
    }
  }

  provideAudio(chunk: ArrayBuffer, capture?: AudioCapture, seq?: number): void {
    if (!this.runtime || this.paused || this.viewing) return;
    this.runtime.sendAudio(chunk, capture, seq);
  }

  endAudioCapture(capture: AudioCaptureEnd): void {
    if (!this.runtime || this.viewing || this.ending || capture.sessionId !== this.runtime.session.id) return;
    this.runtime.endAudioCapture(capture);
  }
}
