import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@rcc/shared";
import { extractCitations } from "../src/qa/citations.js";

/**
 * §33: citations are extracted from the model's own prose, so this is a parsing contract against
 * text we do not control. The cases here come from live answers, not from the prompt's wording.
 */

function segment(id: string, startTime: number): TranscriptSegment {
  return {
    id,
    sessionId: "s",
    text: `第 ${id} 句`,
    startTime,
    type: "final",
    createdAt: 0,
  };
}

const context = [segment("s-1", 10), segment("s-2", 41), segment("s-3", 52), segment("s-9", 750)];

describe("extractCitations", () => {
  it("reads every clock inside one bracket", () => {
    // A live qwen3.8-flash grouped two sources into `[00:10, 00:52]`. A single-clock regex matched
    // neither, so the answer shipped visible time marks with an empty citation list.
    expect(extractCitations("它能学习环境动态 [00:10, 00:52]。", context)).toEqual([
      { transcriptId: "s-1", startTime: 10 },
      { transcriptId: "s-3", startTime: 52 },
    ]);
  });

  it("still reads the adjacent and spaced forms", () => {
    expect(extractCitations("结论。[00:41][00:52]", context).map((c) => c.transcriptId)).toEqual(["s-2", "s-3"]);
    expect(extractCitations("结论。[00:41] [00:52]", context).map((c) => c.transcriptId)).toEqual(["s-2", "s-3"]);
  });

  it("drops a clock that points at nothing in the snapshot", () => {
    expect(extractCitations("这一点在 [09:04] 提到过。", context)).toEqual([]);
  });

  it("ignores a bare time outside brackets", () => {
    // Widening the parser must not turn every `mm:ss` in prose into a source.
    expect(extractCitations("演讲者在 12:30 之后才回到主题。", context)).toEqual([]);
  });

  it("reports a clock only once per segment", () => {
    expect(extractCitations("先看 [00:10]，再看 [00:10, 00:10]。", context)).toEqual([
      { transcriptId: "s-1", startTime: 10 },
    ]);
  });
});
