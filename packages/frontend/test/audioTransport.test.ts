import { afterEach, describe, expect, it, vi } from "vitest";

class Socket {
  static OPEN = 1; static CONNECTING = 0; static instances: Socket[] = [];
  readyState = 0; bufferedAmount = 0; sent: string[] = []; failSend = false;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage = null; onerror = null;
  constructor(_url: string) { Socket.instances.push(this); }
  addEventListener() {}
  send(data: string) { if (this.failSend) throw Error("closing race"); this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
}

async function load() {
  vi.resetModules(); Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  return import("../src/net/connection");
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("bounded audio transport", () => {
  it("queues only the end metadata across offline and send/close races", async () => {
    const net = await load();
    const capture = { sessionId: "s1", captureId: "c1", originTime: 0, endTime: 0.3, nextSeq: 3 };
    net.sendCaptureEnd(capture);
    expect(net.sendCommand({ cmd: "audio.chunk", seq: 0, pcmBase64: "AAA=" })).toBe(false);
    net.connect("ws://test/ws"); Socket.instances[0]?.open();
    expect(Socket.instances[0]?.sent.map((s) => JSON.parse(s))).toEqual([{ cmd: "audio.capture.end", capture }]);
    const first = Socket.instances[0]; if (!first) throw Error("socket missing");
    first.failSend = true;
    expect(() => net.sendCaptureEnd({ ...capture, captureId: "c2" })).not.toThrow();
    net.resyncFromServer(); Socket.instances[1]?.open();
    expect(Socket.instances[1]?.sent.map((s) => JSON.parse(s))).toEqual([{ cmd: "audio.capture.end", capture: { ...capture, captureId: "c2" } }]);
    net.disconnect();
  });

  it("drops audio under backpressure while allowing control and never replaying PCM", async () => {
    const net = await load(); net.connect("ws://test/ws");
    const socket = Socket.instances[0]; if (!socket) throw Error("socket missing"); socket.open();
    socket.bufferedAmount = 256 * 1024 + 1;
    expect(net.sendCommand({ cmd: "audio.chunk", seq: 7, pcmBase64: "AAA=" })).toBe(false);
    expect(net.sendCommand({ cmd: "recording.pause" })).toBe(true);
    socket.bufferedAmount = 0;
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([{ cmd: "recording.pause" }]);
    net.disconnect();
  });
});
