import { monitorEventLoopDelay } from "node:perf_hooks";
import { metric } from "./log.js";

/**
 * Event-loop delay sampling (§47, Phase 8).
 *
 * This exists because "the UI stayed smooth" is not a claim you can make after a two-hour talk —
 * Test F needs a number, and §9.2 D-12 chose `worker_threads` precisely on the strength of one.
 * Sampling is a leaf: it never changes behaviour, and `unref` means a monitor can't keep the process
 * alive.
 */

/** The slice of Node's histogram that is read. Injectable so the maths is testable without waiting
 *  on a real loop; Node reports percentiles at integer ranks and durations in nanoseconds. */
interface DelayHistogram {
  percentile(percentile: number): number;
  readonly max: number;
  readonly mean: number;
  enable(): void;
  disable(): void;
  reset(): void;
}

export interface LoopDelaySnapshot {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

const toMs = (nanoseconds: number): number => Math.round((nanoseconds / 1e6) * 10) / 10;

export class LoopDelayMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly histogram: DelayHistogram,
    private readonly reportMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.histogram.enable();
    this.timer = setInterval(() => {
      const snapshot = this.report();
      metric("loop_delay", { windowMs: this.reportMs, ...snapshot });
    }, this.reportMs);
    // Observability must never be the reason a shutdown hangs.
    this.timer.unref?.();
  }

  /** The current window, then forget it — a report covers only the time since the last one. */
  report(): LoopDelaySnapshot {
    const snapshot = this.snapshot();
    this.histogram.reset();
    return snapshot;
  }

  snapshot(): LoopDelaySnapshot {
    return {
      p50Ms: toMs(this.histogram.percentile(50)),
      p95Ms: toMs(this.histogram.percentile(95)),
      maxMs: toMs(this.histogram.max),
      meanMs: toMs(this.histogram.mean),
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram.disable();
  }
}

export function createLoopDelayMonitor(reportMs: number): LoopDelayMonitor {
  // Measured on this machine: an idle loop reads p50 15.6 ms at resolution 5, 31.2 at 20, 62.2 at 50
  // — integer multiples of the 15.625 ms Windows clock tick. So sub-tick values are noise and only
  // p95/max discriminate; ADR §6.1 D-15 is how to read a soak run's numbers.
  return new LoopDelayMonitor(monitorEventLoopDelay({ resolution: 5 }), reportMs);
}
