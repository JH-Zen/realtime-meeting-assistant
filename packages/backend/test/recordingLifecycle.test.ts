import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createHarness, wait } from "./pipelineHarness.js";
import { MOCK_SCRIPT } from "../src/testing/mockScript.js";

async function delayedWorker() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const clients: WebSocket[] = [];
  server.on("connection", (socket) => {
    clients.push(socket);
    socket.on("message", (raw, binary) => {
      if (!binary && JSON.parse(raw.toString()).type === "flush") socket.send(JSON.stringify({ type: "flushed", finals: 0 }));
    });
  });
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing worker address");
  return {
    clients, url: `ws://127.0.0.1:${address.port}`,
    ready() { for (const client of clients) if (client.readyState === client.OPEN) client.send(JSON.stringify({ type: "ready", protocol: 1, sampleRate: 16000, model: "delayed-test-worker" })); },
    final() { for (const client of clients) if (client.readyState === client.OPEN) client.send(JSON.stringify({ type: "final", seq: 1, text: "迟到的旧会话", startSec: 0, endSec: 1 })); },
    async close() { for (const client of server.clients) client.terminate(); await new Promise<void>((done) => server.close(() => done())); },
  };
}

describe("recording lifecycle cancellation", () => {
  it("stopping during the STT handshake cannot resurrect an old provider or subscriptions", async () => {
    const worker = await delayedWorker();
    const h = createHarness({ mockStt: false, sttWsUrl: worker.url });
    const baseline = h.bus.snapshot().listeners;
    const pending = h.recording.start("mic");
    try {
      await wait(30);
      const staleRuntime = h.recording.current;
      const sessionId = h.recording.sessionId ?? "";
      await h.recording.stop();
      worker.ready();
      await pending;
      worker.final();
      await wait(25);
      expect(h.recording.state).toBe("idle");
      expect(staleRuntime?.sttEngine).toBeNull();
      expect(h.bus.snapshot().listeners).toBe(baseline);
      expect(h.transcripts.countFinal(sessionId)).toBe(0);
      expect(worker.clients.every((client) => client.readyState !== client.OPEN)).toBe(true);
    } finally { await h.recording.stop(); await worker.close(); await pending; h.close(); }
  });

  it("a newer recording waits for cleanup and rejects callbacks from the cancelled start", async () => {
    const worker = await delayedWorker();
    const h = createHarness({ mockStt: false, sttWsUrl: worker.url });
    const first = h.recording.start("mic");
    try {
      await wait(25);
      const oldId = h.recording.sessionId ?? "";
      const second = h.recording.start("mock");
      worker.ready();
      const newId = await second;
      await first;
      worker.final();
      await wait(25);
      expect(newId).not.toBe(oldId);
      expect(h.recording.sessionId).toBe(newId);
      expect(h.recording.current?.sttEngine).toBe("mock");
      expect(h.transcripts.countFinal(oldId)).toBe(0);
      await h.recording.stop();
      expect(h.bus.snapshot().listeners).toBe(0);
    } finally { await h.recording.stop(); await worker.close(); await first; h.close(); }
  });

  it("simultaneous stop requests drain a session once", async () => {
    const h = createHarness();
    const stopped: string[] = [];
    const off = h.bus.on("ui", "recording.stopped", (event) => { stopped.push(event.sessionId); });
    try {
      await h.recording.start("mock");
      await Promise.all([h.recording.stop(), h.recording.stop(), h.recording.stop()]);
      await wait(0);
      expect(stopped).toHaveLength(1);
      expect(h.recording.state).toBe("idle");
    } finally { off(); h.close(); }
  });

  it("pauses the mock input without losing the remaining script on resume", async () => {
    const h = createHarness();
    try {
      const id = await h.recording.start("mock");
      await wait(20);
      h.recording.pause();
      const pausedCount = h.transcripts.countFinal(id);
      await wait(90);
      expect(h.transcripts.countFinal(id)).toBe(pausedCount);
      h.recording.resume();
      await wait(200);
      expect(h.transcripts.listFinal(id).map((row) => row.text)).toEqual(MOCK_SCRIPT.map((line) => line.text));
    } finally { await h.recording.stop(); h.close(); }
  });
});
