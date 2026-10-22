import { describe, expect, it, vi } from "vitest";
import { createBus } from "../src/bus/eventBus.js";
import type { ModuleError } from "@rcc/shared";

const segment = {
  id: "t1",
  sessionId: "s1",
  text: "世界模型",
  startTime: 0,
  type: "final" as const,
  createdAt: 1,
};

describe("event bus fault isolation", () => {
  it("keeps sibling listeners running when one listener throws", async () => {
    const bus = createBus();
    const survivor = vi.fn();
    bus.on("mindmap", "transcript.final", () => {
      throw new Error("mind map agent exploded");
    });
    bus.on("transcript", "transcript.final", survivor);

    bus.emit("transcript.final", segment);
    await vi.waitFor(() => expect(survivor).toHaveBeenCalledWith(segment));
  });

  it("reports a throwing listener on module.error with its module attribution", async () => {
    const bus = createBus();
    const errors: ModuleError[] = [];
    bus.onError((error) => errors.push(error));
    bus.on("qa", "transcript.final", () => {
      throw new Error("boom");
    });

    bus.emit("transcript.final", segment);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]?.module).toBe("qa");
    expect(errors[0]?.code).toBe("handler_failed");
  });

  it("waits for async listeners that reject, and still isolates them", async () => {
    const bus = createBus();
    const errors: ModuleError[] = [];
    const survivor = vi.fn();
    bus.onError((error) => errors.push(error));
    bus.on("mindmap", "transcript.final", async () => {
      await Promise.reject(new Error("async boom"));
    });
    bus.on("qa", "transcript.final", survivor);

    bus.emit("transcript.final", segment);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]?.message).toContain("async boom");
    expect(survivor).toHaveBeenCalled();
  });

  it("unsubscribes per listener", async () => {
    const bus = createBus();
    const handler = vi.fn();
    const off = bus.on("ui", "transcript.final", handler);
    bus.emit("transcript.final", segment);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    off();
    bus.emit("transcript.final", { ...segment, id: "t2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("counts published events for the debug panel", () => {
    const bus = createBus();
    bus.emit("transcript.final", segment);
    bus.emit("transcript.final", { ...segment, id: "t2" });
    expect(bus.snapshot().events["transcript.final"]).toBe(2);
  });

  it("reports live listener counts so a soak can see a leak", () => {
    const bus = createBus();
    const before = bus.snapshot().listeners;
    const offUi = bus.on("ui", "transcript.final", () => {});
    const offMindmap = bus.on("mindmap", "transcript.final", () => {});
    expect(bus.snapshot().listeners).toBe(before + 2);
    offUi();
    offMindmap();
    // A count that only ever goes up is the leak Test F looks for; returning to the baseline is the
    // whole claim this field makes.
    expect(bus.snapshot().listeners).toBe(before);
  });

  it("never lets a failing error listener recurse", () => {
    const bus = createBus();
    bus.onError(() => {
      throw new Error("logger is broken");
    });
    expect(() =>
      bus.emit("module.error", {
        module: "bus",
        code: "x",
        message: "y",
        at: 1,
        recoverable: true,
      }),
    ).not.toThrow();
  });
});
