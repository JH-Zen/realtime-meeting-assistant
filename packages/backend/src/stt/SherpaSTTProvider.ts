import WebSocket from "ws";
import { z } from "zod";
import type { AudioGapInput, AudioInputPosition, SttStatus, TranscriptSegment } from "@rcc/shared";
import { log } from "../observability/log.js";
import type { STTProvider } from "./STTProvider.js";

/**
 * The frame the local sherpa-onnx worker sends (`services/stt-worker/stt_worker.py`, protocol v1).
 * Validated here because a third party's payload must not reach core code even when it comes from a
 * process on the same machine — a silently mis-shaped frame would become a corrupted segment.
 */
const WorkerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    protocol: z.number().int(),
    sampleRate: z.number().int(),
    model: z.string(),
    endpoint: z
      .object({ rule1: z.number(), rule2: z.number(), rule3: z.number() })
      .partial()
      .optional(),
  }),
  z.object({
    type: z.enum(["partial", "final"]),
    seq: z.number().int().min(0),
    text: z.string(),
    startSec: z.number(),
    endSec: z.number(),
  }),
  z.object({ type: z.literal("flushed"), finals: z.number().int().min(0) }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
type WorkerFrame = z.infer<typeof WorkerFrameSchema>;

/** Only metadata is retained. Adjacent PCM frames share one span until the source clock jumps. */
interface AudioClockSpan {
  captureId: string;
  lastSeq: number;
  workerStart: number;
  workerEnd: number;
  sourceStart: number;
  sourceEnd: number;
}

const AUDIO_BACKPRESSURE_BYTES = 256 * 1024;
const CLOCK_EPSILON = 1e-7;

export interface SherpaWorkerOptions {
  url: string;
  /** What the microphone path encodes. A mismatch would make every timestamp wrong, so it is checked. */
  sampleRate: number;
  connectTimeoutMs?: number;
  /** How long `disconnect()` waits for the worker's last final before closing anyway. */
  flushTimeoutMs?: number;
  /** Per-attempt waits for §45's STT reconnect. Tests shorten it; production uses the default. */
  reconnectDelaysMs?: number[];
}

/**
 * §45 asks STT to reconnect by itself, and the common cause is a developer or a user restarting the
 * Python process — which takes a couple of seconds to load a model. Eight attempts over ~24 s covers
 * that; past it the worker is gone for the session and saying so is better than dialling forever.
 */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 5000, 5000, 5000];

/**
 * Real streaming STT: a WebSocket client of the local sherpa-onnx worker (design doc §16, Phase 5).
 *
 * Audio goes out as raw s16le frames; recognised text comes back as partials and finals. Nothing
 * here decides what is durable — `TranscriptCore` does, and it only ever persists finals. When the
 * worker is not running, `connect()` fails with a message that names the command to start.
 */
export class SherpaSTTProvider implements STTProvider {
  readonly name = "sherpa-onnx";
  private socket: WebSocket | null = null;
  private ready = false;
  private closing = false;
  /** True only while a handshake awaits its answer: a dial that fails is the caller's business. */
  private handshaking = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  /**
   * A reconnected worker is a fresh session whose utterance numbers restart at 1 and whose speech
   * clock restarts at 0. Both would collide with what this session already stored — the ids dedupe
   * into nothing and the timeline rewinds — so each connection is shifted by what came before it.
   */
  private seqOffset = 0;
  private clockOffsetSec = 0;
  private connectionMaxSeq = 0;
  private connectionMaxEndSec = 0;
  private connectionSawFrame = false;
  private sentSamples = 0;
  private finalizedAudioSec = 0;
  private audioSpans: AudioClockSpan[] = [];
  private droppedChunks = 0;
  private warnedAboutDrops = false;
  private resolveFlushed: (() => void) | null = null;
  /** Set only while the handshake is waiting for its answer. */
  private pendingFrame: ((frame: WorkerFrame | null) => void) | null = null;
  private lastSocketError = "";
  private drainingSocket: WebSocket | null = null;
  private disconnectJob: Promise<void> | null = null;
  private handshakeFrames: WorkerFrame[] = [];
  private readonly partialCallbacks: Array<(segment: TranscriptSegment) => void> = [];
  private readonly finalCallbacks: Array<(segment: TranscriptSegment) => void> = [];
  private readonly statusCallbacks: Array<(status: SttStatus) => void> = [];
  private readonly audioGapCallbacks: Array<(gap: AudioGapInput) => void> = [];

  constructor(
    private readonly sessionId: string,
    private readonly options: SherpaWorkerOptions,
  ) {}

  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.socket) return;
    this.closing = false;
    this.disconnectJob = null;
    this.lastSocketError = "";
    const abort = () => { void this.disconnect(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const model = await this.openOnce();
      signal?.throwIfAborted();
      if (this.closing) throw new DOMException("STT connection cancelled", "AbortError");
      log.info("stt worker connected", { sessionId: this.sessionId, url: this.options.url, model });
    } finally { signal?.removeEventListener("abort", abort); }
  }

  /** Dial, handshake, and refuse anything the backend cannot honour. Throws without scheduling a retry. */
  private async openOnce(): Promise<string> {
    const socket = new WebSocket(this.options.url, { maxPayload: 8 * 1024 * 1024 });
    this.sentSamples = 0;
    this.finalizedAudioSec = 0;
    this.audioSpans = [];
    this.socket = socket;
    this.handshaking = true;
    this.handshakeFrames = [];
    // Handlers go on before anything can arrive, so no frame can land between the handshake and the
    // subscription — the worker sends its first results as soon as the socket opens.
    this.watchSocket(socket);
    try {
      const frame = await this.nextFrame(this.options.connectTimeoutMs ?? 5000);
      if (this.closing || this.socket !== socket) throw new DOMException("STT connection cancelled", "AbortError");
      const ready = frame?.type === "ready" ? frame : null;
      if (!ready) {
        throw new Error(this.refused(`未收到 worker 的 ready。请先启动：python services/stt-worker/stt_worker.py --model-dir <模型目录>`, socket));
      }
      if (ready.protocol !== 1) {
        throw new Error(this.refused(`worker 协议版本 ${ready.protocol} 与后端不匹配（支持 v1）`, socket));
      }
      if (ready.sampleRate !== this.options.sampleRate) {
        // Accepting it anyway would make every timestamp wrong by the ratio of the two rates.
        throw new Error(
          this.refused(`worker 以 ${ready.sampleRate} Hz 解码，后端按 ${this.options.sampleRate} Hz 上行音频（STT_SAMPLE_RATE）`, socket),
        );
      }
      this.ready = true;
      this.handshaking = false;
      const pending = this.handshakeFrames;
      this.handshakeFrames = [];
      for (const queued of pending) if (queued.type === "partial" || queued.type === "final") this.deliver(queued);
      return ready.model;
    } finally {
      if (this.socket === socket) this.handshaking = false;
    }
  }

  /** Close the half-open socket and build the message the user sees when the worker is unreachable. */
  private refused(reason: string, socket: WebSocket): string {
    // Detach first: the close event of this socket is the failed dial itself, not a lost session.
    if (this.socket === socket) this.socket = null;
    this.ready = false;
    this.handshakeFrames = [];
    socket?.close();
    const detail = this.lastSocketError ? `：${this.lastSocketError}` : "";
    return `无法连接 STT worker（${this.options.url}）${reason}${detail}`;
  }

  sendAudio(data: ArrayBuffer, position?: AudioInputPosition): void {
    // Late caller frames after an intentional stop are outside the recording, not an outage.
    if (this.closing) return;
    const socket = this.socket;
    const samples = Math.floor(data.byteLength / 2);
    const durationSec = samples / this.options.sampleRate;
    if (!socket || !this.ready || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > AUDIO_BACKPRESSURE_BYTES) {
      this.noteDrop(position, durationSec);
      return;
    }
    try {
      socket.send(Buffer.from(data));
    } catch {
      this.noteDrop(position, durationSec);
      return;
    }
    const workerStart = this.sentSamples / this.options.sampleRate;
    this.sentSamples += samples;
    if (position && durationSec > 0) {
      this.recordAudioSpan(position, workerStart, this.sentSamples / this.options.sampleRate, durationSec);
    }
  }

  disconnect(): Promise<void> {
    this.disconnectJob ??= this.disconnectOwned();
    return this.disconnectJob;
  }

  private async disconnectOwned(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.handshakeFrames = [];
    if (this.handshaking) {
      this.pendingFrame?.(null);
      this.handshaking = false;
      socket?.terminate();
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (socket) socket.close();
      return;
    }
    // The last sentence is still inside the recogniser when the user stops; flushing makes the
    // worker emit its final before the socket goes away, so nothing spoken is lost.
    const flushed = new Promise<void>((resolve) => {
      this.resolveFlushed = resolve;
    });
    this.drainingSocket = socket;
    socket.send(JSON.stringify({ type: "flush" }));
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([flushed, new Promise<void>((done) => { timeout = setTimeout(done, this.options.flushTimeoutMs ?? 2000); })]);
    clearTimeout(timeout);
    this.resolveFlushed = null;
    this.drainingSocket = null;
    socket.close();
    if (this.droppedChunks > 0) {
      log.warn("stt audio chunks dropped while the worker was unreachable", {
        sessionId: this.sessionId,
        droppedChunks: this.droppedChunks,
      });
    }
  }

  onPartial(callback: (segment: TranscriptSegment) => void): void {
    this.partialCallbacks.push(callback);
  }

  onFinal(callback: (segment: TranscriptSegment) => void): void {
    this.finalCallbacks.push(callback);
  }

  onStatus(callback: (status: SttStatus) => void): void {
    this.statusCallbacks.push(callback);
  }

  onAudioGap(callback: (gap: AudioGapInput) => void): void {
    this.audioGapCallbacks.push(callback);
  }

  /** Resolve with the next validated frame, or `null` if the socket dies or nothing arrives in time. */
  private nextFrame(timeoutMs: number): Promise<WorkerFrame | null> {
    return new Promise((resolve) => {
      const settle = (frame: WorkerFrame | null) => {
        clearTimeout(timer);
        this.pendingFrame = null;
        resolve(frame);
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      this.pendingFrame = settle;
    });
  }

  private watchSocket(socket: WebSocket): void {
    socket.on("message", (raw: WebSocket.RawData) => {
      if (socket !== this.socket && socket !== this.drainingSocket) return;
      const frame = parseFrame(raw);
      if (!frame) return;
      // While the handshake is open, the first valid frame is its answer and nothing else.
      if (this.pendingFrame) {
        this.pendingFrame(frame);
        return;
      }
      if (frame.type === "partial" || frame.type === "final") {
        if (this.handshaking) {
          if (this.handshakeFrames.length < 64) this.handshakeFrames.push(frame);
        } else this.deliver(frame);
      } else if (frame.type === "flushed") {
        this.resolveFlushed?.();
      } else if (frame.type === "error") {
        this.reportStatus("failed", `worker 报告 ${frame.code}: ${frame.message}`, 0);
      }
    });
    socket.on("error", (error: Error) => {
      if (socket !== this.socket || this.closing) return;
      this.lastSocketError = error.message;
      log.warn("stt worker socket error", { sessionId: this.sessionId, error: error.message });
      this.pendingFrame?.(null);
    });
    socket.on("close", () => {
      if (socket === this.drainingSocket) { this.resolveFlushed?.(); return; }
      if (socket !== this.socket) return;
      this.pendingFrame?.(null);
      this.handleLost(socket);
    });
  }

  /** The only place that decides between "session over" and "worker went away, dial again". */
  private handleLost(socket: WebSocket): void {
    this.ready = false;
    if (this.closing || this.handshaking) return;
    // A stale socket (already replaced, or the one a failed dial detached) is not this session's loss.
    if (socket !== this.socket) return;
    this.socket = null;
    this.reportUnconfirmedAudio();
    this.seqOffset += this.connectionMaxSeq || (this.connectionSawFrame ? 1 : 0);
    this.clockOffsetSec += this.connectionMaxEndSec;
    this.connectionMaxSeq = 0;
    this.connectionMaxEndSec = 0;
    this.connectionSawFrame = false;
    this.sentSamples = 0;
    this.finalizedAudioSec = 0;
    this.audioSpans = [];
    this.scheduleReconnect("STT worker 断开了连接");
  }

  private scheduleReconnect(reason: string): void {
    if (this.closing) return;
    const delays = this.options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    if (this.reconnectTimer) return;
    const waitMs = delays[this.reconnectAttempts];
    if (waitMs === undefined) {
      this.reportStatus("failed", `${reason}（已重试 ${this.reconnectAttempts} 次后放弃）`, this.reconnectAttempts);
      return;
    }
    this.reconnectAttempts += 1;
    this.reportStatus("reconnecting", `${reason}，正在重连（第 ${this.reconnectAttempts} 次尝试）`, this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, waitMs);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closing) return;
    this.lastSocketError = "";
    try {
      const model = await this.openOnce();
      if (this.closing) return;
      this.reconnectAttempts = 0;
      this.reportStatus("connected", `已重连（模型 ${model}）`, 0);
      log.info("stt worker reconnected", { sessionId: this.sessionId, url: this.options.url, model });
    } catch (error) {
      if (this.closing) return;
      // A dial that dies mid-handshake never reaches `handleLost`, so the next attempt is scheduled here.
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  private deliver(frame: Extract<WorkerFrame, { type: "partial" | "final" }>): void {
    const text = frame.text.trim();
    if (!text) return;
    this.connectionSawFrame = true;
    this.connectionMaxSeq = Math.max(this.connectionMaxSeq, frame.seq);
    this.connectionMaxEndSec = Math.max(this.connectionMaxEndSec, frame.endSec);
    if (frame.type === "final") {
      // A final supplies a processed-audio boundary, not a transport ACK or proof of text coverage.
      this.finalizedAudioSec = Math.max(this.finalizedAudioSec, Math.min(frame.endSec, this.sentSamples / this.options.sampleRate));
    }
    const startTime = this.mapAudioTime(frame.startSec, "start");
    const endTime = this.mapAudioTime(frame.endSec, "end");
    const now = Date.now();
    const segment: TranscriptSegment = {
      id: `${this.sessionId}-live-${frame.seq + this.seqOffset}`,
      sessionId: this.sessionId,
      text,
      startTime,
      type: frame.type,
      createdAt: now,
      ...(frame.type === "final" ? { endTime: this.audioSpans.length > 0 ? Math.max(startTime, endTime) : endTime } : {}),
    };
    for (const callback of frame.type === "final" ? this.finalCallbacks : this.partialCallbacks) callback(segment);
  }

  private reportStatus(state: SttStatus["state"], message: string, attempts: number): void {
    const status: SttStatus = { sessionId: this.sessionId, state, attempts, message };
    for (const callback of this.statusCallbacks) callback(status);
  }

  private recordAudioSpan(position: AudioInputPosition, workerStart: number, workerEnd: number, durationSec: number): void {
    const previous = this.audioSpans.at(-1);
    const sourceEnd = position.startTime + durationSec;
    if (previous && previous.captureId === position.captureId && position.seq === previous.lastSeq + 1 &&
      Math.abs(previous.workerEnd - workerStart) < CLOCK_EPSILON && Math.abs(previous.sourceEnd - position.startTime) < CLOCK_EPSILON) {
      previous.lastSeq = position.seq;
      previous.workerEnd = workerEnd;
      previous.sourceEnd = sourceEnd;
      return;
    }
    this.audioSpans.push({ captureId: position.captureId, lastSeq: position.seq, workerStart, workerEnd, sourceStart: position.startTime, sourceEnd });
  }

  private mapAudioTime(rawSec: number, side: "start" | "end"): number {
    if (this.audioSpans.length === 0) return this.clockOffsetSec + rawSec;
    const time = Math.max(0, Math.min(rawSec, this.sentSamples / this.options.sampleRate));
    // At a discontinuity, a start belongs to the next source span and an end to the previous one.
    for (const span of this.audioSpans) {
      const beforeEnd = side === "start" ? time < span.workerEnd - CLOCK_EPSILON : time <= span.workerEnd + CLOCK_EPSILON;
      if (beforeEnd && time >= span.workerStart - CLOCK_EPSILON) {
        return span.sourceStart + Math.max(0, Math.min(time - span.workerStart, span.workerEnd - span.workerStart));
      }
    }
    const last = this.audioSpans.at(-1);
    if (last && time >= last.workerEnd - CLOCK_EPSILON) return last.sourceEnd;
    // A mixed legacy prefix has no source metadata. Preserve its previous offset-based behaviour.
    return this.clockOffsetSec + time;
  }

  private reportUnconfirmedAudio(): void {
    for (const span of this.audioSpans) {
      const start = Math.max(span.workerStart, this.finalizedAudioSec);
      if (span.workerEnd - start <= CLOCK_EPSILON) continue;
      this.reportAudioGap({
        stage: "backend_stt", reason: "worker_disconnect", certainty: "possible",
        startTime: span.sourceStart + start - span.workerStart, endTime: span.sourceEnd,
      });
    }
  }

  private reportAudioGap(gap: AudioGapInput): void {
    for (const callback of this.audioGapCallbacks) {
      try { callback(gap); }
      catch (error) { log.warn("stt audio gap callback failed", { sessionId: this.sessionId, error: String(error) }); }
    }
  }

  private noteDrop(position?: AudioInputPosition, durationSec = 0): void {
    this.droppedChunks += 1;
    if (position && durationSec > 0) {
      this.reportAudioGap({ stage: "backend_stt", reason: "worker_unavailable", certainty: "observed", startTime: position.startTime, endTime: position.startTime + durationSec });
    }
    // One warning per outage, not one per 100 ms frame: a worker that is down would otherwise flood
    // the log, and the counter at disconnect already says how much audio was lost.
    if (!this.warnedAboutDrops) {
      this.warnedAboutDrops = true;
      log.warn("stt audio dropped: worker socket is not open", { sessionId: this.sessionId, url: this.options.url });
    }
  }
}

function parseFrame(raw: WebSocket.RawData): WorkerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  const parsed = WorkerFrameSchema.safeParse(value);
  if (!parsed.success) {
    log.warn("dropped unrecognised stt worker frame", { issues: parsed.error.issues.length });
    return null;
  }
  return parsed.data;
}
