import type { MindMapNode, TranscriptSegment } from "@rcc/shared";

/**
 * MindMap prompt (design doc §35). The user block is also what the Mock LLM parses, so the format
 * must carry everything a model needs: existing node ids, transcript ids, and speech times.
 */

const OUTPUT_INSTRUCTION = `你输出的是"图操作补丁"，不是完整思维导图。
规则：
1. 只允许 add_node / update_node / move_node / merge_node / delete_node / add_edge 六种操作。
2. 绝不重复创建已存在的概念：能复用就复用已有节点 id，必要时用 merge_node 合并。
3. 每次最多 6 个操作，只处理"本批转写"里的新信息。
4. 节点标题不超过 14 个字，必须是概念或论断，不是句子全文。
5. 每个 add_node 都要带 summary：不超过 40 字，说明这个节点在当前语境里指什么，不要复述标题。
6. 顶层主题可以是多个，不要强行造一个总节点。
7. 严格输出 JSON：{"operations":[{"type":"add_node","node":{"id":"...","title":"...","summary":"...","parentId":"...","sourceTranscriptIds":["..."]}}]}
8. 没有值得记录的新信息时输出 {"operations":[]}。`;

export function mindmapSystemPrompt(): string {
  return `你在为一场实时演讲增量维护思维导图。你会看到当前相关节点和本批转写文本，你的职责是把新信息挂到正确的位置上。\n\n${OUTPUT_INSTRUCTION}`;
}

export interface MindMapPromptInput {
  relevantNodes: MindMapNode[];
  batch: TranscriptSegment[];
  themeSummary?: string;
}

export function mindmapUserPrompt(input: MindMapPromptInput): string {
  const nodes = input.relevantNodes
    .map((node) => `id=${node.id} | title=${node.title}${node.summary ? ` | 摘要=${node.summary}` : ""}`)
    .join("\n");
  const lines = input.batch.map(
    (segment) => `id=${segment.id} | [${segment.startTime.toFixed(1)}s] ${segment.text}`,
  );
  return [
    input.themeSummary ? `### 当前主题摘要\n${input.themeSummary}` : "",
    `### 当前相关节点\n${nodes || "(空图，还没有任何节点)"}`,
    `### 本批转写\n${lines.join("\n")}`,
    "请只针对本批转写输出图操作 JSON。",
  ]
    .filter(Boolean)
    .join("\n\n");
}
