import type { SummaryBlock, TranscriptSegment } from "@rcc/shared";
import { transcriptLine } from "./format.js";

/**
 * Summary prompts (§31, kept in /prompts per §35). The user block is also what the Mock LLM parses,
 * so it must carry the transcript ids and speech times the block is built from — the same contract
 * the MindMap prompt follows.
 */

const OUTPUT_INSTRUCTION = `严格输出 JSON：{"summary":"...","keyPoints":["..."],"entities":["..."]}
1. summary 不超过 120 字：写给稍后回看这段记录的人，说清这段时间得出了什么，不要逐句复述。
2. keyPoints 3～6 条，每条不超过 30 字，写成论断或结论，不写"演讲者说了"这类空话。
3. entities 只列文本中出现过的名词（技术、模型、人物、机构、指标），没有就给空数组。
4. 只能使用给出的文本。文本很短或没有实质内容时，用一句话如实说明，不要编造，也不要留空 JSON。`;

export type SummaryPromptInput =
  | { kind: "stage"; segments: TranscriptSegment[] }
  | { kind: "merge"; children: SummaryBlock[] };

export function summarySystemPrompt(kind: SummaryPromptInput["kind"]): string {
  const lead =
    kind === "stage"
      ? "你在为一场实时演讲的分段记录生成阶段摘要。你会看到这一段时间内的转写原文，需要把它压成一段可回看的摘要。"
      : "你在为一场实时演讲合并已有的阶段摘要。你会看到连续的几段阶段摘要，需要产出一段覆盖整个区间的上层摘要，保留各段的关键结论。";
  return `${lead}\n\n${OUTPUT_INSTRUCTION}`;
}

export function summaryUserPrompt(input: SummaryPromptInput): string {
  if (input.kind === "merge") {
    const blocks = input.children.map(
      (block) =>
        `id=${block.id} | [${block.startTime.toFixed(1)}s-${block.endTime.toFixed(1)}s] ${block.summary}` +
        (block.keyPoints.length > 0 ? `\n要点：${block.keyPoints.join("；")}` : ""),
    );
    return [
      `### 待合并的阶段摘要\n${blocks.join("\n\n")}`,
      "请输出覆盖以上全部区间的 JSON 摘要。",
    ].join("\n\n");
  }
  const lines = input.segments.map((segment) => `id=${segment.id} | ${transcriptLine(segment)}`);
  return [`### 本阶段转写\n${lines.join("\n")}`, "请输出本阶段的 JSON 摘要。"].join("\n\n");
}
