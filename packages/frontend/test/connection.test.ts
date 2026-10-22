import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reconnect loop is the part of the client that has to survive a worse-than-expected world, and it
 * is all module-level state, so these tests load the module fresh for every case and drive a fake
 * socket by hand. Three properties matter: the backoff is bounded and restarts after a success, a
 * socket that has been replaced cannot start a second connection (that is how every event would reach
 * the stores twice), and a deliberate disconnect ends the retrying.
 */

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((frame: { data: string }) => void) | null = null;
  private openListeners: (() => void)[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, handler: () => void): void {
    if (type === "open") this.openListeners.push(handler);
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("send on a closed socket");
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** Test-side: the handshake completed. */
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    for (const handler of this.openListeners) handler();
  }

  /** Test-side: the link dropped. `onerror` closes the socket, so this must not double-fire retries. */
  fail(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onerror?.();
    this.onclose?.();
  }

  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

interface ConnectionModule {
  connect(url: string): void;
  disconnect(): void;
  sendCommand(command: unknown): boolean;
}

interface StoreModule {
  useSessionStore: {
    getState(): {
      link: string;
      reconnectAttempts: number;
      droppedFrames: number;
      finals: { id: string }[];
    };
  };
}

async function load(): Promise<{ connection: ConnectionModule; store: StoreModule["useSessionStore"] }> {
  vi.resetModules();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const connection = (await import("../src/net/connection")) as unknown as ConnectionModule;
  const { useSessionStore } = (await import("../src/state/sessionStore")) as unknown as StoreModule;
  return { connection, store: useSessionStore };
}

const segmentEvent = {
  kind: "transcript.final",
  segment: {
    id: "t-1",
    sessionId: "s1",
    text: "世界模型能预测下一个状态。",
    startTime: 10,
    endTime: 13,
    confidence: 0.9,
    type: "final",
    createdAt: 11000,
  },
};

describe("websocket connection state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("dials once and reports the link as open", async () => {
    const { connection, store } = await load();

    connection.connect("ws://h/ws");
    expect(FakeSocket.instances).toHaveLength(1);
    expect(store.getState().link).toBe("connecting");
    expect(store.getState().reconnectAttempts).toBe(0);

    FakeSocket.instances[0]?.accept();
    expect(store.getState().link).toBe("open");
  });

  it("backs off 1s, 2s, 4s and then stays at the 8s ceiling", async () => {
    const { connection, store } = await load();
    connection.connect("ws://h/ws");

    const expected = [1000, 2000, 4000, 8000, 8000];
    for (const [round, delay] of expected.entries()) {
      FakeSocket.instances.at(-1)?.fail();
      expect(store.getState().link).toBe("closed");
      expect(store.getState().reconnectAttempts).toBe(round + 1);

      vi.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances).toHaveLength(round + 1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(round + 2);
    }
  });

  it("restarts the backoff after a connection succeeds", async () => {
    const { connection, store } = await load();
    connection.connect("ws://h/ws");

    FakeSocket.instances[0]?.fail();
    vi.advanceTimersByTime(1000);
    FakeSocket.instances[1]?.fail();
    vi.advanceTimersByTime(2000);
    FakeSocket.instances[2]?.accept();
    expect(store.getState().reconnectAttempts).toBe(0);

    FakeSocket.instances[2]?.fail();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(4);
    expect(store.getState().reconnectAttempts).toBe(1);
  });

  it("ignores the close of a socket that has already been replaced", async () => {
    const { connection } = await load();
    connection.connect("ws://h/ws");
    const first = FakeSocket.instances[0];
    connection.connect("ws://h/ws");
    expect(FakeSocket.instances).toHaveLength(2);

    first?.fail();
    vi.advanceTimersByTime(60_000);
    // One live dial, no retry started by the discarded socket, and no doubled event fan-out.
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stops retrying when the client disconnects on purpose", async () => {
    const { connection } = await load();
    connection.connect("ws://h/ws");
    FakeSocket.instances[0]?.fail();
    connection.disconnect();

    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("closes a socket that is still handshaking instead of abandoning it", async () => {
    const { connection } = await load();
    connection.connect("ws://h/ws");
    const socket = FakeSocket.instances[0];
    connection.disconnect();

    expect(socket?.readyState).toBe(FakeSocket.CONNECTING);
    socket?.accept();
    expect(socket?.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("applies frames the schema accepts and counts the ones it does not", async () => {
    const { connection, store } = await load();
    connection.connect("ws://h/ws");
    const socket = FakeSocket.instances[0];
    socket?.accept();

    socket?.emit(segmentEvent);
    socket?.emit({ kind: "transcript.final", segment: { id: 1 } });

    expect(store.getState().finals.map((row) => row.id)).toEqual(["t-1"]);
    expect(store.getState().droppedFrames).toBe(1);
  });

  it("reports a command that cannot leave because the link is down", async () => {
    const { connection, store } = await load();
    connection.connect("ws://h/ws");
    const socket = FakeSocket.instances[0];

    expect(connection.sendCommand({ cmd: "recording.pause" })).toBe(false);
    socket?.accept();
    expect(connection.sendCommand({ cmd: "recording.start", source: "mock" })).toBe(true);
    expect(socket?.sent).toHaveLength(1);

    socket?.fail();
    expect(connection.sendCommand({ cmd: "recording.pause" })).toBe(false);
    expect(store.getState().link).toBe("closed");
  });
});
