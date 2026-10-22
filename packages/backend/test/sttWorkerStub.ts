import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A local stand-in for `services/stt-worker/stt_worker.py`, so `SherpaSTTProvider` is tested against
 * the real WebSocket wire — framing, handshake order, malformed frames, a socket that disappears —
 * without needing Python or a model. Test-only.
 */
export interface WorkerScript {
  /** Defaults to a valid v1 handshake at 16 kHz; `null` never announces ready. */
  ready?: { protocol: number; sampleRate: number; model: string } | null;
  /** Frames pushed as soon as a client connects. */
  frames?: unknown[];
  /** Frames pushed when the client sends `{"type":"flush"}`. */
  flushFrames?: unknown[];
}

export interface SttWorkerStub {
  url: string;
  /** Bound port, so a test can bring a "new worker process" up at the same address. */
  port: number;
  /** Binary audio frames received, so a test can prove nothing is queued while the link is down. */
  audioFrames: number;
  /** Decoded control frames received. */
  controls: unknown[];
  send(frame: unknown): void;
  close(): Promise<void>;
}

export async function startSttWorkerStub(script: WorkerScript = {}, port = 0): Promise<SttWorkerStub> {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  const stub: SttWorkerStub = {
    url: "",
    port,
    audioFrames: 0,
    controls: [],
    send: () => {},
    // `WebSocketServer.close()` leaves existing connections alone and its callback waits for them,
    // so "the worker process died" has to hang up on the client first.
    close: () => {
      for (const client of server.clients) client.terminate();
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
  let client: WebSocket | null = null;

  server.on("connection", (socket) => {
    client = socket;
    const ready = script.ready === undefined ? { protocol: 1, sampleRate: 16000, model: "stub" } : script.ready;
    if (ready) socket.send(JSON.stringify({ type: "ready", ...ready }));
    for (const frame of script.frames ?? []) socket.send(JSON.stringify(frame));
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        stub.audioFrames += 1;
        return;
      }
      const control = JSON.parse(raw.toString());
      stub.controls.push(control);
      if (control.type === "flush") {
        for (const frame of script.flushFrames ?? []) socket.send(JSON.stringify(frame));
        socket.send(JSON.stringify({ type: "flushed", finals: 1 }));
      }
    });
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  stub.port = (server.address() as AddressInfo).port;
  stub.url = `ws://127.0.0.1:${stub.port}`;
  stub.send = (frame) => client?.send(JSON.stringify(frame));
  return stub;
}
