import { describe, expect, it } from "vitest";
import { TranscriptSegmentSchema, type ModuleError, type TranscriptSegment } from "@rcc/shared";
import { MockSTTProvider } from "../src/stt/MockSTTProvider.js";
import { SherpaSTTProvider } from "../src/stt/SherpaSTTProvider.js";
import { startSttWorkerStub } from "./sttWorkerStub.js";
import { createHarness, wait } from "./pipelineHarness.js";
import { MOCK_SCRIPT } from "../src/testing/mockScript.js";

/**
 * Adapter contract (§51): whatever engine sits behind `STTProvider`, it may only ever emit
 * canonical `TranscriptSegment` values. This test is the gate a real provider must pass in Phase 5.
 */
describe("STT adapter contract", () => {
  it("emits only schema-valid segments", async () => {
    const provider = new MockSTTProvider("s1", 400);
    const emitted: unknown[] = [];
    provider.onPartial((segment) => emitted.push(segment));
    provider.onFinal((segment) => emitted.push(segment));

    await provider.connect();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await provider.disconnect();

    expect(emitted.length).toBeGreaterThan(0);
    for (const item of emitted) {
      expect(TranscriptSegmentSchema.safeParse(item).success, JSON.stringify(item)).toBe(true);
    }
  });

  it("grows each partial into a final carrying the whole line", async () => {
    const provider = new MockSTTProvider("s1", 400);
    const partials = new Map<string, string[]>();
    const finals = new Map<string, string>();
    provider.onPartial((segment) => {
      partials.set(segment.id, [...(partials.get(segment.id) ?? []), segment.text]);
    });
    provider.onFinal((segment) => finals.set(segment.id, segment.text));

    await provider.connect();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await provider.disconnect();

    expect([...finals.values()]).toEqual(MOCK_SCRIPT.map((line) => line.text));
    for (const [id, texts] of partials) {
      const final = finals.get(id);
      expect(final).toBeDefined();
      expect(texts.every((text) => final?.startsWith(text))).toBe(true);
      expect(texts).toEqual([...new Set(texts).values()]);
    }
  });

  it("stops emitting once disconnected, so a stopped session cannot leak segments", async () => {
    const provider = new MockSTTProvider("s1", 1);
    const finals: string[] = [];
    provider.onFinal((segment) => finals.push(segment.id));

    await provider.connect();
    await provider.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(finals).toEqual([]);
  });
});

const frame = (type: "partial" | "final", seq: number, text: string, startSec: number, endSec: number) => ({
  type,
  seq,
  text,
  startSec,
  endSec,
});

function collect(provider: SherpaSTTProvider) {
  const partials: TranscriptSegment[] = [];
  const finals: TranscriptSegment[] = [];
  provider.onPartial((segment) => partials.push(segment));
  provider.onFinal((segment) => finals.push(segment));
  return { partials, finals };
}

/**
 * The same contract, now exercised over a real WebSocket against a stand-in for
 * `services/stt-worker/stt_worker.py`. The point is the wire: handshake order, unknown frames, a
 * socket that disappears, and the flush that keeps the last sentence.
 */
describe("STT adapter contract — sherpa worker wire", () => {
  it("turns worker frames into schema-valid segments that share one id per utterance", async () => {
    const stub = await startSttWorkerStub({
      frames: [
        frame("partial", 1, "今天", 0, 1.1),
        frame("partial", 1, "今天讨论世界模型", 0, 2.4),
        frame("final", 1, "今天讨论世界模型。", 0, 3.7),
        frame("final", 2, "世界模型能够学习环境的动态变化。", 3.7, 8.2),
      ],
    });
    const provider = new SherpaSTTProvider("s1", { url: stub.url, sampleRate: 16000 });
    const { partials, finals } = collect(provider);

    await provider.connect();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await provider.disconnect();

    expect(partials.map((segment) => segment.text)).toEqual(["今天", "今天讨论世界模型"]);
    expect(finals.map((segment) => segment.text)).toEqual([
      "今天讨论世界模型。",
      "世界模型能够学习环境的动态变化。",
    ]);
    for (const segment of [...partials, ...finals]) {
      expect(TranscriptSegmentSchema.safeParse(segment).success, JSON.stringify(segment)).toBe(true);
      expect(segment.sessionId).toBe("s1");
    }
    // One id per utterance is what lets a partial be replaced by its final instead of doubling up.
    expect(new Set(partials.map((segment) => segment.id))).toEqual(new Set(["s1-live-1"]));
    expect(finals.map((segment) => segment.id)).toEqual(["s1-live-1", "s1-live-2"]);
    // Times stay speech-relative; only a final has an end.
    expect(finals[0]?.startTime).toBe(0);
    expect(finals[0]?.endTime).toBe(3.7);
    expect(partials[0]?.endTime).toBeUndefined();
    await stub.close();
  });

  it("drops a frame the schema does not accept instead of inventing a segment", async () => {
    const stub = await startSttWorkerStub();
    const provider = new SherpaSTTProvider("s1", { url: stub.url, sampleRate: 16000 });
    const { partials, finals } = collect(provider);
    await provider.connect();

    stub.send({ type: "final", seq: 1, text: 42, startSec: 0, endSec: 1 });
    stub.send({ type: "final", seq: "x", text: "缺字段" });
    stub.send({ noise: true });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect([...partials, ...finals]).toEqual([]);
    // Still usable afterwards: one bad frame must not end the recording.
    stub.send(frame("final", 1, "仍然可用", 0, 1));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(finals.map((segment) => segment.text)).toEqual(["仍然可用"]);
    await provider.disconnect();
    await stub.close();
  });

  it("refuses a worker whose protocol or sample rate the backend cannot honour", async () => {
    const mismatched = await startSttWorkerStub({ ready: { protocol: 2, sampleRate: 16000, model: "x" } });
    await expect(
      new SherpaSTTProvider("s1", { url: mismatched.url, sampleRate: 16000 }).connect(),
    ).rejects.toThrow(/协议版本 2/);
    await mismatched.close();

    const wrongRate = await startSttWorkerStub({ ready: { protocol: 1, sampleRate: 8000, model: "x" } });
    await expect(
      new SherpaSTTProvider("s1", { url: wrongRate.url, sampleRate: 16000 }).connect(),
    ).rejects.toThrow(/8000 Hz/);
    await wrongRate.close();
  });

  it("names the worker command when nothing is listening", async () => {
    const gone = await startSttWorkerStub();
    await gone.close();
    const provider = new SherpaSTTProvider("s1", {
      url: gone.url,
      sampleRate: 16000,
      connectTimeoutMs: 500,
    });
    await expect(provider.connect()).rejects.toThrow(/stt_worker\.py/);
  });

  it("flushes the utterance in flight before the socket closes", async () => {
    const stub = await startSttWorkerStub({ flushFrames: [frame("final", 1, "这是最后一句", 9, 12.4)] });
    const provider = new SherpaSTTProvider("s1", { url: stub.url, sampleRate: 16000 });
    const { finals } = collect(provider);
    await provider.connect();

    await provider.disconnect();

    expect(finals.map((segment) => segment.text)).toEqual(["这是最后一句"]);
    expect(stub.controls).toEqual([{ type: "flush" }]);
    await stub.close();
  });

  it("reconnects a worker that comes back, keeping ids and the speech clock continuous", async () => {
    const first = await startSttWorkerStub({
      frames: [frame("final", 1, "第一句", 0, 3.2), frame("final", 2, "第二句", 3.2, 6.0)],
    });
    const provider = new SherpaSTTProvider("s1", {
      url: first.url,
      sampleRate: 16000,
      reconnectDelaysMs: [40],
    });
    const { partials, finals } = collect(provider);
    const statuses: string[] = [];
    provider.onStatus((status) => {
      statuses.push(`${status.state}:${status.attempts}`);
    });
    await provider.connect();
    expect(finals.map((segment) => segment.id)).toEqual(["s1-live-1", "s1-live-2"]);

    // The process dies, not merely the socket: nothing answers at that address for a moment.
    await first.close();
    // The browser keeps sending, and the audio of the outage is a gap, not a queue.
    provider.sendAudio(new ArrayBuffer(3200));
    expect(finals).toHaveLength(2);

    // "Restart the worker" — a fresh process on the same address, numbering from 1 again.
    const second = await startSttWorkerStub(
      { frames: [frame("partial", 1, "第三句", 0, 1.5), frame("final", 1, "第三句。", 0, 2.4)] },
      first.port,
    );
    for (let i = 0; i < 60 && finals.length < 3; i++) await wait(50);

    // A restarted worker re-uses 1, which would collide with the stored first line; the offset is
    // what turns "silently dropped as a duplicate" into a new segment.
    expect(finals.map((segment) => segment.id)).toEqual(["s1-live-1", "s1-live-2", "s1-live-3"]);
    expect(partials.at(-1)?.id).toBe("s1-live-3");
    expect(finals[2]?.startTime).toBeCloseTo(6.0, 6);
    expect(finals[2]?.endTime).toBeCloseTo(8.4, 6);
    expect(statuses).toEqual(expect.arrayContaining(["reconnecting:1", "connected:0"]));
    provider.sendAudio(new ArrayBuffer(3200));
    await wait(50);
    expect(second.audioFrames).toBe(1);

    await provider.disconnect();
    await second.close();
  });

  it("gives up after its retries and survives the audio that keeps arriving", async () => {
    const gone = await startSttWorkerStub();
    const provider = new SherpaSTTProvider("s1", {
      url: gone.url,
      sampleRate: 16000,
      reconnectDelaysMs: [20, 20],
    });
    const statuses: string[] = [];
    provider.onStatus((status) => {
      statuses.push(`${status.state}:${status.attempts}`);
    });
    const { finals } = collect(provider);
    await provider.connect();

    await gone.close();
    for (let i = 0; i < 50 && !statuses.some((entry) => entry.startsWith("failed")); i++) await wait(20);

    expect(statuses.slice(0, 2)).toEqual(["reconnecting:1", "reconnecting:2"]);
    expect(statuses.at(-1)).toContain("failed");
    // Giving up is a status, not an exception: the client has no idea the worker is gone.
    provider.sendAudio(new ArrayBuffer(3200));
    expect(finals).toEqual([]);
    await provider.disconnect();
  });

  it("drops audio sent before the handshake instead of queueing it", async () => {
    const stub = await startSttWorkerStub();
    const provider = new SherpaSTTProvider("s1", { url: stub.url, sampleRate: 16000 });
    provider.sendAudio(new ArrayBuffer(3200));
    await provider.connect();
    provider.sendAudio(new ArrayBuffer(3200));
    await provider.disconnect();
    expect(stub.audioFrames).toBe(1);
    await stub.close();
  });
});

/**
 * The runtime side of the same contract: which provider `recording.start` picks, and what the rest
 * of the system is allowed to see from it. Mock Mode is the load-bearing case — a build that quietly
 * recognises a script while claiming to use the microphone would make every other test worthless.
 */
describe("STT adapter contract — runtime wiring", () => {
  it("refuses the microphone while Mock Mode is on, instead of pretending to listen", async () => {
    const h = createHarness();
    const errors: ModuleError[] = [];
    const statuses: string[] = [];
    const finals: string[] = [];
    h.bus.onError((error) => errors.push(error));
    h.bus.on("ui", "stt.status", (status) => {
      statuses.push(status.state);
    });
    h.bus.on("ui", "transcript.final", (segment) => {
      finals.push(segment.text);
    });

    await h.recording.start("mic");
    h.recording.provideAudio(new ArrayBuffer(3200));
    await wait(80);

    expect(errors.map((error) => `${error.module}:${error.code}`)).toEqual(["stt:mock_mode_active"]);
    expect(errors[0]?.message).toContain("MOCK_STT=false");
    expect(statuses).toEqual(["failed"]);
    expect(finals).toEqual([]);
    // The audio has nowhere to go, and that must stay a drop rather than a queue.
    expect(h.transcripts.countFinal(h.recording.sessionId ?? "")).toBe(0);
    h.close();
  });

  it("persists the worker's finals and never its partials", async () => {
    const stub = await startSttWorkerStub({
      frames: [
        frame("partial", 1, "今天", 0, 1.0),
        frame("partial", 1, "今天讨论世界模型", 0, 2.0),
        frame("final", 1, "今天讨论世界模型。", 0, 2.6),
      ],
      flushFrames: [frame("final", 2, "它需要长期记忆。", 2.6, 4.1)],
    });
    const h = createHarness({ mockStt: false, sttWsUrl: stub.url });
    const partials: string[] = [];
    const finals: string[] = [];
    h.bus.on("ui", "transcript.partial", (segment) => {
      partials.push(segment.text);
    });
    h.bus.on("ui", "transcript.final", (segment) => {
      finals.push(segment.text);
    });

    const sessionId = await h.recording.start("mic");
    expect(h.recording.current?.sttEngine).toBe("sherpa-onnx");
    h.recording.provideAudio(new ArrayBuffer(3200));
    await wait(80);
    expect(stub.audioFrames).toBe(1);
    expect(finals).toEqual(["今天讨论世界模型。"]);
    // Live subtitles need the growth, so partials reach the bus...
    expect(partials).toEqual(["今天", "今天讨论世界模型"]);
    // ...and stop at the bus: the store only ever holds the final they were replaced by.
    expect(h.transcripts.listFinal(sessionId).map((row) => row.text)).toEqual(["今天讨论世界模型。"]);

    await h.recording.stop();
    expect(h.transcripts.listFinal(sessionId).map((row) => row.text)).toEqual([
      "今天讨论世界模型。",
      "它需要长期记忆。",
    ]);
    expect(stub.controls).toEqual([{ type: "flush" }]);
    await stub.close();
    h.close();
  });

  it("keeps the session alive when nothing is listening, and says so", async () => {
    const gone = await startSttWorkerStub();
    const url = gone.url;
    await gone.close();
    const h = createHarness({ mockStt: false, sttWsUrl: url });
    const errors: ModuleError[] = [];
    h.bus.onError((error) => errors.push(error));

    await expect(h.recording.start("mic")).resolves.toEqual(expect.any(String));
    expect(errors.map((error) => error.code)).toEqual(["connect_failed"]);
    expect(errors[0]?.message).toContain("stt_worker.py");
    // §44: a failed module is an error on the bus, not a dead process.
    expect(h.recording.state).toBe("recording");
    h.recording.provideAudio(new ArrayBuffer(3200));
    await h.recording.stop();
    h.close();
  });
});
