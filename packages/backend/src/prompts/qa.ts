import type { MindMapNode, TranscriptSegment } from "@rcc/shared";
import { transcriptLine } from "./format.js";

/** QA prompt (§27 context assembly → §33 time citations). Wired in Phase 4. */

export function qaSystemPrompt(): string {
  return `你在回答关于一场正在进行演讲的问题。
要求：
1. 只使用给出的上下文，上下文不足时明确说明"目前转写中没有提到"。
2. 引用来源，用 [mm:ss] 形式标注转写时间。
3. 回答简洁，先结论后依据，不重复问题。
4. 演讲仍在继续：不要因为信息不完整而反问用户，除非确实无法回答。`;
}

export interface QaPromptInput {
  question: string;
  hotContext: TranscriptSegment[];
  relevantTranscripts: TranscriptSegment[];
  globalSummary: string;
  relevantNodes: MindMapNode[];
}

export function qaUserPrompt(input: QaPromptInput): string {
  return [
    `### 全局摘要\n${input.globalSummary || "(会议刚开始，还没有阶段摘要)"}`,
    `### 相关思维导图节点\n${input.relevantNodes.map((node) => `- ${node.title}`).join("\n") || "(暂无)"}`,
    `### 最近转写（热上下文）\n${input.hotContext.map(transcriptLine).join("\n") || "(暂无)"}`,
    `### 检索到的历史转写\n${input.relevantTranscripts.map(transcriptLine).join("\n") || "(暂无)"}`,
    `### 问题\n${input.question}`,
  ].join("\n\n");
}
