import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioCaptureEnd, ClientCommand } from "@rcc/shared";

const transport = vi.hoisted(() => ({ send: vi.fn<(command: ClientCommand) => boolean>(), end: vi.fn<(capture: AudioCaptureEnd) => void>() }));
vi.mock("../src/net/connection", () => ({ sendCommand: transport.send, sendCaptureEnd: transport.end }));
import { startMicrophone, stopAllMicrophones } from "../src/audio/microphone";
import { useSessionStore } from "../src/state/sessionStore";

let ports: { onmessage: ((event: { data: Int16Array }) => void) | null }[] = [];
function emit(index = ports.length - 1): void { ports[index]?.onmessage?.({ data: new Int16Array(1600) }); }
function start(id = "s1"): void { useSessionStore.getState().apply({ kind: "recording.started", sessionId: id, at: 1, source: "mic" }); }

beforeEach(() => {
  ports = []; transport.send.mockReset().mockReturnValue(true); transport.end.mockReset();
  useSessionStore.setState({ sessionId: null, recording: "idle", elapsedSec: 0 });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  vi.stubGlobal("AudioContext", class {
    state = "running"; destination = {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() { this.state = "closed"; }
  });
  vi.stubGlobal("AudioWorkletNode", class {
    port = { onmessage: null }; constructor() { ports.push(this.port); }
    connect() {} disconnect() {}
  });
});
afterEach(() => { stopAllMicrophones(); vi.unstubAllGlobals(); });

describe("microphone source timeline (synthetic capture only)", () => {
  it("excludes preparation audio and binds only after recording acknowledgement", async () => {
    const capture = await startMicrophone(); emit();
    expect(transport.send).not.toHaveBeenCalled();
    start(); emit();
    expect(transport.send.mock.calls[0]?.[0]).toMatchObject({ cmd: "audio.chunk", seq: 0, capture: { sessionId: "s1", originTime: 0, startTime: 0 } });
    capture.stop();
    expect(transport.end.mock.calls[0]?.[0]).toMatchObject({ sessionId: "s1", nextSeq: 1, originTime: 0, endTime: 0.1 });
  });

  it("advances sample positions despite failed upload and discloses the captured tail", async () => {
    start(); const capture = await startMicrophone();
    transport.send.mockReturnValue(false); emit(); emit();
    const frames = transport.send.mock.calls.map(([frame]) => frame);
    expect(frames[0]).toMatchObject({ seq: 0, capture: { startTime: 0 } });
    expect(frames[1]).toMatchObject({ seq: 1, capture: { startTime: 0.1 } });
    capture.stop();
    expect(transport.end.mock.calls[0]?.[0]).toMatchObject({ nextSeq: 2, endTime: 0.2 });
  });

  it("uses a new capture identity and the resumed active clock after pause", async () => {
    start(); const first = await startMicrophone(); emit(); first.stop();
    useSessionStore.getState().apply({ kind: "recording.paused", sessionId: "s1", state: "paused", elapsedSec: 5.4 });
    const second = await startMicrophone(); emit();
    expect(transport.send).toHaveBeenCalledTimes(1);
    useSessionStore.getState().apply({ kind: "recording.resumed", sessionId: "s1", state: "recording", elapsedSec: 5.4 }); emit();
    const a = transport.send.mock.calls[0]?.[0], b = transport.send.mock.calls[1]?.[0];
    expect(b).toMatchObject({ seq: 0, capture: { originTime: 5.4, startTime: 5.4 } });
    if (a?.cmd !== "audio.chunk" || b?.cmd !== "audio.chunk") throw Error("Expected microphone frame");
    expect(b.capture?.captureId).not.toBe(a.capture?.captureId);
    second.stop();
  });

  it("never sends queued old-capture audio into a new meeting or after release", async () => {
    start(); await startMicrophone(); emit();
    start("s2"); emit();
    expect(transport.send).toHaveBeenCalledTimes(1);
    stopAllMicrophones(); emit();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.end.mock.calls[0]?.[0].sessionId).toBe("s1");
  });
});
