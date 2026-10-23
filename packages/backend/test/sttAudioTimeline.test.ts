import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { AudioGapSchema, TranscriptSegmentSchema, type AudioGapInput, type AudioInputPosition, type SttStatus, type TranscriptSegment } from "@rcc/shared";
import { SherpaSTTProvider, type SherpaWorkerOptions } from "../src/stt/SherpaSTTProvider.js";
import { startSttWorkerStub, type SttWorkerStub, type WorkerScript } from "./sttWorkerStub.js";

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const pcm = (seconds: number) => new ArrayBuffer(Math.round(seconds * 16000) * 2);
const position = (seq: number, startTime: number, durationSec: number, captureId = "capture-a"): AudioInputPosition => ({ captureId, seq, startTime, durationSec });
const result = (type: "partial" | "final", seq: number, startSec: number, endSec: number) => ({ type, seq, startSec, endSec, text: "合成识别结果" });

async function until(read: () => boolean, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (read()) return;
    await wait(5);
  }
  throw new Error("STT audio timeline assertion timed out");
}

async function fixture(script: WorkerScript = {}, options: Partial<SherpaWorkerOptions> = {}, connect = true) {
  let worker = await startSttWorkerStub(script);
  const workers = [worker];
  const closed = new Set<SttWorkerStub>();
  const provider = new SherpaSTTProvider("timeline-session", {
    url: worker.url, sampleRate: 16000, connectTimeoutMs: 500, flushTimeoutMs: 100,
    reconnectDelaysMs: [30, 30, 30, 30, 30], ...options,
  });
  const finals: TranscriptSegment[] = [];
  const partials: TranscriptSegment[] = [];
  const gaps: AudioGapInput[] = [];
  const statuses: SttStatus[] = [];
  provider.onFinal((segment) => finals.push(segment));
  provider.onPartial((segment) => partials.push(segment));
  provider.onAudioGap((gap) => gaps.push(gap));
  provider.onStatus((status) => statuses.push(status));
  if (connect) await provider.connect();
  return {
    provider, finals, partials, gaps, statuses,
    get worker() { return worker; },
    async crash() {
      const count = statuses.length;
      await worker.close();
      closed.add(worker);
      await until(() => statuses.slice(count).some((status) => status.state === "reconnecting" || status.state === "failed"));
    },
    async restart(next: WorkerScript = {}, awaitConnected = true) {
      const count = statuses.filter((status) => status.state === "connected").length;
      worker = await startSttWorkerStub(next, worker.port);
      workers.push(worker);
      if (awaitConnected) await until(() => statuses.filter((status) => status.state === "connected").length > count);
      return worker;
    },
    async close() {
      await provider.disconnect();
      for (const instance of workers) if (!closed.has(instance)) { await instance.close(); closed.add(instance); }
    },
  };
}

describe("STT sent-audio to source timeline", () => {
  it("keeps source jumps on one worker, with starts on the right and ends on the left of a boundary", async () => {
    const h = await fixture();
    try {
      h.provider.sendAudio(pcm(1), position(0, 10, 1));
      h.provider.sendAudio(pcm(1), position(1, 11, 1));
      h.provider.sendAudio(pcm(1), position(4, 20, 1));
      await until(() => h.worker.audioFrames === 3);
      h.worker.send(result("final", 1, 0, 2));
      h.worker.send(result("partial", 2, 2, 2.5));
      h.worker.send(result("final", 2, 2, 3));
      h.worker.send(result("final", 3, 1.5, 2.5));
      await until(() => h.finals.length === 3 && h.partials.length === 1);
      expect(h.finals.map((entry) => [entry.startTime, entry.endTime])).toEqual([[10, 12], [20, 21], [11.5, 20.5]]);
      expect(h.partials[0]?.startTime).toBe(20);
      expect(h.partials[0]?.endTime).toBeUndefined();
      expect(h.gaps).toEqual([]);
      for (const entry of [...h.finals, ...h.partials]) expect(TranscriptSegmentSchema.safeParse(entry).success).toBe(true);
      // The crossing utterance keeps its interval; this test does not claim continuous audio in 12..20.
    } finally { await h.close(); }
  });

  it("anchors a restarted worker after sent but unrecognised silence instead of the last text end", async () => {
    const h = await fixture();
    try {
      h.provider.sendAudio(pcm(2), position(0, 0, 2));
      h.provider.sendAudio(pcm(3), position(1, 2, 3));
      await until(() => h.worker.audioFrames === 2);
      h.worker.send(result("final", 1, 0, 1));
      await until(() => h.finals.length === 1);
      await h.crash();
      expect(h.gaps).toEqual([{ stage: "backend_stt", reason: "worker_disconnect", certainty: "possible", startTime: 1, endTime: 5 }]);
      h.provider.sendAudio(pcm(1), position(2, 5, 1));
      expect(h.gaps.at(-1)).toEqual({ stage: "backend_stt", reason: "worker_unavailable", certainty: "observed", startTime: 5, endTime: 6 });
      await h.restart();
      h.provider.sendAudio(pcm(1), position(3, 6, 1));
      await until(() => h.worker.audioFrames === 1);
      h.worker.send(result("partial", 1, 0, 0.5));
      h.worker.send(result("final", 1, 0, 1));
      await until(() => h.finals.length === 2);
      expect(h.finals.map((entry) => entry.id)).toEqual(["timeline-session-live-1", "timeline-session-live-2"]);
      expect(h.finals[1]).toMatchObject({ startTime: 6, endTime: 7 });
      expect(h.partials.at(-1)).toMatchObject({ id: "timeline-session-live-2", startTime: 6 });
    } finally { await h.close(); }
  });

  it("retains the source anchor after a connection with no recognition result at all", async () => {
    const h = await fixture();
    try {
      h.provider.sendAudio(pcm(3), position(0, 10, 3));
      await until(() => h.worker.audioFrames === 1);
      await h.crash();
      expect(h.gaps).toEqual([{ stage: "backend_stt", reason: "worker_disconnect", certainty: "possible", startTime: 10, endTime: 13 }]);
      await h.restart();
      h.provider.sendAudio(pcm(1), position(1, 14, 1));
      await until(() => h.worker.audioFrames === 1);
      h.worker.send(result("final", 1, 0, 1));
      await until(() => h.finals.length === 1);
      expect(h.finals[0]).toMatchObject({ startTime: 14, endTime: 15 });
    } finally { await h.close(); }
  });

  it("reports disjoint unconfirmed sent ranges without filling a source gap that was never sent", async () => {
    const h = await fixture();
    try {
      h.provider.sendAudio(pcm(1), position(0, 0, 1));
      h.provider.sendAudio(pcm(1), position(4, 4, 1));
      await until(() => h.worker.audioFrames === 2);
      h.worker.send(result("final", 1, 0, 0.5));
      await until(() => h.finals.length === 1);
      await h.crash();
      expect(h.gaps).toEqual([
        { stage: "backend_stt", reason: "worker_disconnect", certainty: "possible", startTime: 0.5, endTime: 1 },
        { stage: "backend_stt", reason: "worker_disconnect", certainty: "possible", startTime: 4, endTime: 5 },
      ]);
      for (const gap of h.gaps) expect(AudioGapSchema.safeParse({ ...gap, id: "synthetic-gap", sessionId: "timeline-session", createdAt: 1 }).success).toBe(true);
    } finally { await h.close(); }
  });

  it("coalesces continuous small-frame metadata into one observable unconfirmed range", async () => {
    const h = await fixture();
    try {
      for (let seq = 0; seq < 100; seq++) h.provider.sendAudio(pcm(0.01), position(seq, 30 + seq * 0.01, 0.01));
      await until(() => h.worker.audioFrames === 100);
      await h.crash();
      expect(h.gaps).toHaveLength(1);
      expect(h.gaps[0]).toMatchObject({ reason: "worker_disconnect", certainty: "possible", startTime: 30 });
      expect(h.gaps[0]?.endTime).toBeCloseTo(31, 8);
    } finally { await h.close(); }
  });

  it("accepts a new capture after a deliberate pause without inventing loss or including paused wall time", async () => {
    const h = await fixture();
    try {
      h.provider.sendAudio(pcm(1), position(0, 0, 1, "before-pause"));
      await until(() => h.worker.audioFrames === 1);
      h.worker.send(result("final", 1, 0, 1));
      await until(() => h.finals.length === 1);
      // The caller gates capture during pause. Its active-time position resumes at 1, with a new ID.
      await wait(20);
      h.provider.sendAudio(pcm(1), position(0, 1, 1, "after-pause"));
      await until(() => h.worker.audioFrames === 2);
      h.worker.send(result("final", 2, 1, 2));
      await until(() => h.finals.length === 2);
      expect(h.finals[1]).toMatchObject({ startTime: 1, endTime: 2 });
      await h.provider.disconnect();
      expect(h.gaps).toEqual([]);
    } finally { await h.close(); }
  });

  it("reports pre-handshake drops from actual PCM duration and never replays them on ready", async () => {
    const h = await fixture({}, {}, false);
    try {
      h.provider.sendAudio(pcm(0.1), position(0, 2, 999));
      expect(h.gaps).toEqual([{ stage: "backend_stt", reason: "worker_unavailable", certainty: "observed", startTime: 2, endTime: 2.1 }]);
      await h.provider.connect();
      h.provider.sendAudio(pcm(0.1), position(1, 2.1, 0.1));
      await until(() => h.worker.audioFrames === 1);
      h.worker.send(result("final", 1, 0, 0.1));
      await until(() => h.finals.length === 1);
      expect(h.finals[0]?.startTime).toBe(2.1);
      expect(h.finals[0]?.endTime).toBeCloseTo(2.2, 8);
    } finally { await h.close(); }
  });

  it("drops backpressured frames at 256 KiB without moving the worker clock or replaying audio", async () => {
    const h = await fixture();
    const socket = (h.provider as unknown as { socket: WebSocket }).socket;
    const buffered = vi.spyOn(socket, "bufferedAmount", "get").mockReturnValue(256 * 1024 + 1);
    try {
      h.provider.sendAudio(pcm(1), position(0, 0, 1));
      expect(h.gaps).toEqual([{ stage: "backend_stt", reason: "worker_unavailable", certainty: "observed", startTime: 0, endTime: 1 }]);
      buffered.mockRestore();
      h.provider.sendAudio(pcm(1), position(1, 1, 1));
      await until(() => h.worker.audioFrames === 1);
      h.worker.send(result("final", 1, 0, 1));
      await until(() => h.finals.length === 1);
      expect(h.finals[0]).toMatchObject({ startTime: 1, endTime: 2 });
      await h.provider.disconnect();
      expect(h.worker.audioFrames).toBe(1);
      expect(h.gaps).toHaveLength(1);
    } finally { buffered.mockRestore(); await h.close(); }
  });

  it("flushes mapped final text on normal disconnect without reporting an unexpected loss", async () => {
    const h = await fixture({ flushFrames: [result("final", 1, 0, 1)] });
    try {
      h.provider.sendAudio(pcm(1), position(0, 7, 1));
      await until(() => h.worker.audioFrames === 1);
      await h.provider.disconnect();
      expect(h.finals[0]).toMatchObject({ startTime: 7, endTime: 8 });
      expect(h.worker.controls).toEqual([{ type: "flush" }]);
      h.provider.sendAudio(pcm(1), position(1, 8, 1));
      await wait(20);
      expect(h.worker.audioFrames).toBe(1);
      expect(h.gaps).toEqual([]);
    } finally { await h.close(); }
  });

  it("does not report confirmed sent audio as possible loss when the worker unexpectedly exits", async () => {
    const h = await fixture();
    try {
      h.provider.sendAudio(pcm(1), position(0, 0, 1));
      await until(() => h.worker.audioFrames === 1);
      h.worker.send(result("final", 1, 0, 1));
      await until(() => h.finals.length === 1);
      await h.crash();
      expect(h.gaps).toEqual([]);
    } finally { await h.close(); }
  });

  it("cancels scheduled reconnect on stop and ignores later caller audio and worker text", async () => {
    const h = await fixture({}, { reconnectDelaysMs: [100] });
    try {
      h.provider.sendAudio(pcm(1), position(0, 2, 1));
      await until(() => h.worker.audioFrames === 1);
      await h.crash();
      expect(h.gaps).toHaveLength(1);
      await h.provider.disconnect();
      await h.restart({ frames: [result("final", 1, 0, 1)] }, false);
      h.provider.sendAudio(pcm(1), position(1, 3, 1));
      await wait(160);
      expect(h.finals).toEqual([]);
      expect(h.gaps).toHaveLength(1);
      expect(h.worker.audioFrames).toBe(0);
      expect(h.statuses.some((status) => status.state === "connected")).toBe(false);
    } finally { await h.close(); }
  });

  it("preserves legacy worker timestamps and emits no fabricated gap without positions", async () => {
    const h = await fixture({ frames: [result("final", 1, 0, 6)] });
    try {
      expect(h.finals[0]).toMatchObject({ startTime: 0, endTime: 6 });
      h.provider.sendAudio(pcm(1));
      await until(() => h.worker.audioFrames === 1);
      await h.crash();
      h.provider.sendAudio(pcm(1));
      await h.restart({ frames: [result("final", 1, 0, 2)] });
      await until(() => h.finals.length === 2);
      expect(h.finals[1]).toMatchObject({ id: "timeline-session-live-2", startTime: 6, endTime: 8 });
      expect(h.gaps).toEqual([]);
    } finally { await h.close(); }
  });
});
