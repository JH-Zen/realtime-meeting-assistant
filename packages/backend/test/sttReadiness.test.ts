import { describe, expect, it } from "vitest";
import { probeSttWorker, recordingSttReadiness } from "../src/stt/probe.js";
import { startSttWorkerStub } from "./sttWorkerStub.js";

describe("STT pre-capture readiness", () => {
  it("checks the protocol without sending audio or recording a transcript", async () => {
    const worker = await startSttWorkerStub();
    try {
      expect(await probeSttWorker({ wsUrl: worker.url, sampleRate: 16000 })).toMatchObject({ ready: true, model: "stub" });
      expect(worker.audioFrames).toBe(0);
      expect(worker.controls).toEqual([]);
    } finally { await worker.close(); }
  });
  it("fails a missing worker and mismatched sample rate before capture", async () => {
    const worker = await startSttWorkerStub({ ready: { protocol: 1, sampleRate: 8000, model: "stub" } });
    expect(await probeSttWorker({ wsUrl: worker.url, sampleRate: 16000 })).toMatchObject({ ready: false, message: expect.stringContaining("16000") });
    await worker.close();
    expect(await probeSttWorker({ wsUrl: worker.url, sampleRate: 16000 }, 100)).toMatchObject({ ready: false });
  });
  it("reuses the paused recording's connection and never probes a second worker slot", async () => {
    const config = { mockStt: false, stt: { wsUrl: "ws://127.0.0.1:1", sampleRate: 16000 } };
    expect(await recordingSttReadiness(config, { sttEngine: "sherpa-onnx", sttStatus: "connected" })).toMatchObject({ ready: true });
    expect(await recordingSttReadiness(config, { sttEngine: "sherpa-onnx", sttStatus: "reconnecting" })).toMatchObject({ ready: false });
    expect(await recordingSttReadiness(config, { sttEngine: null, sttStatus: "failed" })).toMatchObject({ ready: false });
    expect(await recordingSttReadiness({ ...config, mockStt: true }, null)).toMatchObject({ ready: false, message: expect.stringContaining("模拟") });
  });
});
