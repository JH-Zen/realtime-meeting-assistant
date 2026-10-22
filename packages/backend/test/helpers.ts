import type { TranscriptSegment } from "@rcc/shared";
import type { BackendConfig } from "../src/config/env.js";
import { LoopDelayMonitor } from "../src/observability/loopDelay.js";
import type { ModuleId, ModuleStatus } from "../src/observability/modules.js";

/** Test config with every knob a unit test needs to not wait in real time. */
export function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    // Deliberately a directory with no `index.html`: server tests must not get a `/*` route mounted,
    // or a missing API route starts answering 404 the way a missing file does and reads as a pass.
    staticDir: "var/test-static-not-built",
    mockStt: true,
    mockLlm: true,
    stt: { wsUrl: "ws://127.0.0.1:0", sampleRate: 16000 },
    llm: { baseUrl: "http://127.0.0.1", apiKey: "", model: "test", timeoutMs: 1000, maxRetries: 0, disableThinking: false },
    mindmap: { minSegments: 2, maxIntervalMs: 50, windowSec: 60 },
    memory: { windowSec: 30, mergeFactor: 3, minSegments: 1, maxLevel: 2 },
    hotContextSec: 120,
    embedding: {
      mock: true,
      model: "Xenova/test-embed",
      dtype: "q8",
      dim: 512,
      modelDir: "var/embedding-test",
      remoteHost: "https://example.invalid/",
      timeoutMs: 1000,
      loadTimeoutMs: 1000,
    },
    retrieval: { topK: 5, minScore: 0.01, batchSize: 4, maxPending: 64 },
    mockSttSpeed: 100,
    // One pass, so a unit test's script is exactly the script.
    mockSttRepeat: 1,
    // Off by default so one gate can be tested at a time; the rate-limit tests opt in.
    qa: { minIntervalMs: 0 },
    observability: { loopDelayReportMs: 3_600_000 },
    ...overrides,
  };
}

/**
 * A monitor whose window is effectively never reached: server tests need the `/api/debug` field to
 * exist, not a sampler that writes records while the suite runs.
 */
export function silentLoopDelay(): LoopDelayMonitor {
  return new LoopDelayMonitor(new FakeHistogram(), 3_600_000);
}

class FakeHistogram {
  percentile(_p: number): number {
    return 0;
  }
  get max(): number {
    return 0;
  }
  get mean(): number {
    return 0;
  }
  enable(): void {}
  disable(): void {}
  reset(): void {}
}

/** Emittery delivers listeners on a microtask, so assertions must let the fan-out run first. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A fixed three-module report for server tests. Reading this machine's `node_modules` and `models` would make
 * `/health` depend on which optional modules happen to be installed here, so the suite asserts on this instead.
 */
export function stubModules(): ModuleStatus[] {
  return (["m1", "m2", "m3"] as ModuleId[]).map((id) => ({
    id,
    label: `${id} (stub)`,
    installed: false,
    checked: [`stub://${id}`],
    remedy: "",
  }));
}

export function segment(
  id: string,
  text: string,
  startTime: number,
  type: "partial" | "final" = "final",
): TranscriptSegment {
  return {
    id,
    sessionId: "s1",
    text,
    startTime,
    ...(type === "final" ? { endTime: startTime + 3 } : {}),
    confidence: 0.9,
    type,
    createdAt: 1000 + startTime * 1000,
  };
}
