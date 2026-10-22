import type { Citation, TranscriptSegment } from "@rcc/shared";
import { formatClock } from "../prompts/format.js";

/**
 * The citation shape is also what a session export has to carry (§13 OPEN-10), so it is defined once
 * in `@rcc/shared` and re-exported here — a second declaration would drift the moment the export
 * grows a field, and the drift would show up as an answer whose citations silently fail to parse.
 */
export type { Citation };

/**
 * A bracket group first, then every clock inside it. The prompt asks for `[mm:ss]`, but a live
 * qwen3.8-flash grouped two sources into one bracket — `[00:10, 00:52]` — and a single-clock regex
 * matched neither, so the answer went out with visible time marks and an empty citation list.
 */
const BRACKET_GROUP = /\[([^[\]]+)]/g;
const CLOCK = /(\d{1,2}:\d{2})/g;

/**
 * §33: a citation only counts if it points at a line the model was actually given. The prompt asks
 * for `[mm:ss]` marks, so each mark is matched against the snapshot's own clocks — a timestamp the
 * model invented for a segment that was never in the context is dropped instead of rendered.
 */
export function extractCitations(answer: string, context: readonly TranscriptSegment[]): Citation[] {
  const byClock = new Map<string, TranscriptSegment>();
  for (const segment of context) {
    const key = formatClock(segment.startTime);
    if (!byClock.has(key)) byClock.set(key, segment);
  }

  const found = new Map<string, Citation>();
  for (const group of answer.matchAll(BRACKET_GROUP)) {
    const inner = group[1];
    if (inner === undefined) continue;
    for (const clock of inner.matchAll(CLOCK)) {
      const mark = clock[1];
      const segment = mark === undefined ? undefined : byClock.get(mark);
      if (!segment || found.has(segment.id)) continue;
      found.set(segment.id, { transcriptId: segment.id, startTime: segment.startTime });
    }
  }
  return [...found.values()];
}
