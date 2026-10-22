import { afterEach, describe, expect, it, vi } from "vitest";
import { startMicrophone } from "../src/audio/microphone";

/**
 * A start that fails half-way is the case that decides whether the microphone is held: the browser
 * has already granted the permission and lit the device indicator, and nothing but `track.stop()`
 * gives it back. These tests fail the build-up one step at a time and check the release.
 */

class FakeTrack {
  readyState = "live";
  stop(): void {
    this.readyState = "ended";
  }
}

interface Failures {
  addModule?: boolean;
  workletNode?: boolean;
  resume?: boolean;
}

class FakeContext {
  /** `startMicrophone` only calls `resume()` when the context came back suspended. */
  state = "suspended";
  closed = false;
  readonly audioWorklet = {
    addModule: async () => {
      if (this.failures.addModule) throw new Error("worklet refused");
    },
  };

  constructor(private readonly failures: Failures) {}

  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }

  get destination() {
    return { connect: () => undefined, disconnect: () => undefined };
  }

  async resume(): Promise<void> {
    this.state = "running";
    if (this.failures.resume) throw new Error("not allowed to start");
  }

  async close(): Promise<void> {
    if (this.state === "closed") throw new Error("already closed");
    this.state = "closed";
    this.closed = true;
  }
}

let contexts: FakeContext[] = [];
let tracks: FakeTrack[] = [];
const originalUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

function install(failures: Failures = {}): void {
  contexts = [];
  tracks = [new FakeTrack(), new FakeTrack()];
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) },
  });
  vi.stubGlobal("AudioContext", function fake() {
    const context = new FakeContext(failures);
    contexts.push(context);
    return context;
  });
  vi.stubGlobal("AudioWorkletNode", function fake() {
    if (failures.workletNode) throw new Error("no such processor");
    return { port: { onmessage: null }, connect: () => undefined, disconnect: () => undefined };
  });
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = originalUrl.create;
  URL.revokeObjectURL = originalUrl.revoke;
});

describe("microphone capture", () => {
  it("releases the device when the worklet module will not compile", async () => {
    install({ addModule: true });
    await expect(startMicrophone()).rejects.toThrow("worklet refused");

    expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
    expect(contexts[0]?.closed).toBe(true);
  });

  it("releases the device when the worklet node cannot be built", async () => {
    install({ workletNode: true });
    await expect(startMicrophone()).rejects.toThrow("no such processor");

    expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
    expect(contexts[0]?.closed).toBe(true);
  });

  it("releases the device when the audio context cannot start", async () => {
    install({ resume: true });
    await expect(startMicrophone()).rejects.toThrow("not allowed to start");

    expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
    expect(contexts[0]?.closed).toBe(true);
  });

  it("stops the tracks the capture hands back", async () => {
    install();
    const capture = await startMicrophone();
    expect(tracks.every((track) => track.readyState === "live")).toBe(true);

    capture.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
    expect(contexts[0]?.closed).toBe(true);
  });
});
