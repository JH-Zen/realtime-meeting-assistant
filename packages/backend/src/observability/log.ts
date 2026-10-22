/**
 * Minimal structured logging (design doc §47). Metrics are emitted as one JSON line per record so
 * a long soak test can be grepped instead of eyeballed. No logging dependency: stdout is enough.
 */

type Level = "debug" | "info" | "warn" | "error";

/**
 * `ts`, `level` and `message` identify a record, and the last of those is the label every grep and soak
 * aggregate keys on. Passing the error text as a field named `message` — which is the natural thing to write,
 * and eleven call sites did — overwrote that label, so `embedding worker stopped` and `retrieval search failed`
 * both arrived as the same indistinguishable error string. Such a field is carried under `detail…` instead,
 * so the record keeps its identity and nothing is dropped.
 */
const RESERVED: Record<string, string> = { message: "detail", level: "detailLevel", ts: "detailTs" };

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  const safe: Record<string, unknown> = { ...fields };
  for (const [key, replacement] of Object.entries(RESERVED)) {
    if (key in safe) {
      safe[replacement] = safe[key];
      delete safe[key];
    }
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...safe });
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};

/** Latency and token accounting; names are stable so a soak run can be aggregated. */
export function metric(name: string, fields: Record<string, number | boolean | string>): void {
  emit("info", `metric:${name}`, fields);
}
