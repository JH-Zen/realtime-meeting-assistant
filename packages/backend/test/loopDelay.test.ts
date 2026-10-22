import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoopDelayMonitor, LoopDelayMonitor } from "../src/observability/loopDelay.js";

/**
 * §47 asks for the number Test F is judged on. Two things can silently break that number: reading
 * Node's histogram wrong (it takes integer percentiles and reports nanoseconds), and a sampler that
 * quietly stops or doubles. Both are tested here without waiting on a real event loop.
 */

class FakeHistogram {
  readonly requested: number[] = [];
  resets = 0;
  enabled = false;
  disableCount = 0;

  percentile(percentile: number): number {
    this.requested.push(percentile);
    return percentile * 1e6;
  }
  get max(): number {
    return 123.45e6;
  }
  get mean(): number {
    return 10.04e6;
  }
  enable(): void {
    this.enabled = true;
  }
  disable(): void {
    this.disableCount += 1;
  }
  reset(): void {
    this.resets += 1;
  }
}

const written: string[] = [];
const stdout = (chunk: unknown): boolean => {
  written.push(String(chunk));
  return true;
};

beforeEach(() => {
  vi.useFakeTimers();
  written.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(stdout);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("loop delay monitor", () => {
  it("converts nanoseconds to ms and asks for integer percentiles", () => {
    const histogram = new FakeHistogram();
    const monitor = new LoopDelayMonitor(histogram, 1000);

    expect(monitor.snapshot()).toEqual({ p50Ms: 50, p95Ms: 95, maxMs: 123.5, meanMs: 10 });
    // `percentile(0.5)` would silently return the wrong rank on Node's histogram.
    expect(histogram.requested).toEqual([50, 95]);
  });

  it("reports a window by resetting it, and snapshots without resetting", () => {
    const histogram = new FakeHistogram();
    const monitor = new LoopDelayMonitor(histogram, 1000);

    monitor.snapshot();
    expect(histogram.resets).toBe(0);
    monitor.report();
    monitor.report();
    expect(histogram.resets).toBe(2);
  });

  it("writes one metric record per window and enables the histogram once", async () => {
    const histogram = new FakeHistogram();
    const monitor = new LoopDelayMonitor(histogram, 1000);

    monitor.start();
    monitor.start();
    await vi.advanceTimersByTimeAsync(2500);
    monitor.stop();

    const records = written.filter((line) => line.includes("metric:loop_delay"));
    expect(records).toHaveLength(2);
    expect(JSON.parse(records[0] ?? "{}")).toMatchObject({ p50Ms: 50, p95Ms: 95, windowMs: 1000 });
    expect(histogram.enabled).toBe(true);
    expect(histogram.disableCount).toBe(1);
  });

  it("stops sampling once stopped, so shutdown cannot emit a trailing storm", async () => {
    const monitor = new LoopDelayMonitor(new FakeHistogram(), 1000);
    monitor.start();
    monitor.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(written.filter((line) => line.includes("metric:loop_delay"))).toHaveLength(0);
  });

  it("reads a real Node histogram without producing an impossible number", async () => {
    // The unit conversion is the part a fake cannot prove: the real API is in nanoseconds, and it
    // refuses to answer percentiles before it has samples — so this one waits in real time.
    vi.useRealTimers();
    const monitor = createLoopDelayMonitor(600_000);
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const snapshot = monitor.snapshot();
    monitor.stop();

    for (const value of Object.values(snapshot)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(60_000);
    }
  });
});
