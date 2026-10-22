/** Shared prompt formatting helpers. */

import type { TranscriptSegment } from "@rcc/shared";

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function transcriptLine(segment: TranscriptSegment): string {
  return `[${formatClock(segment.startTime)}] ${segment.text}`;
}
