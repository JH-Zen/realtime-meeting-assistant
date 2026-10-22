/**
 * One script drives Mock STT and Mock LLM, so `MOCK_STT=true MOCK_LLM=true` reproduces the whole
 * pipeline (subtitle → MindMap) without a microphone or an API key (design doc §49, §50).
 */

export interface MockLine {
  /** Offset from recording start, in seconds of speech time. */
  at: number;
  durationSec: number;
  text: string;
  /** The node the scripted LLM would extract from this line. */
  nodeTitle: string;
  /** Id of the parent node, or `null` for a top-level branch. */
  parentNodeTitle: string | null;
}

export const MOCK_SCRIPT: MockLine[] = [
  { at: 0, durationSec: 4, text: "今天讨论世界模型。", nodeTitle: "世界模型", parentNodeTitle: null },
  {
    at: 10,
    durationSec: 4,
    text: "世界模型能够学习环境的动态变化。",
    nodeTitle: "学习环境动态",
    parentNodeTitle: "世界模型",
  },
  {
    at: 20,
    durationSec: 4,
    text: "这项技术可以应用于机器人和自动驾驶。",
    nodeTitle: "机器人",
    parentNodeTitle: "世界模型",
  },
  {
    at: 30,
    durationSec: 4,
    text: "人工智能正在从大型语言模型逐渐扩展到世界模型。",
    nodeTitle: "人工智能",
    parentNodeTitle: null,
  },
  {
    at: 41,
    durationSec: 6,
    text: "语言模型预测下一个词，世界模型预测世界的下一个状态。",
    nodeTitle: "语言模型",
    parentNodeTitle: "人工智能",
  },
  {
    at: 52,
    durationSec: 4,
    text: "因此世界模型更适合需要长期规划的任务。",
    nodeTitle: "长期规划任务",
    parentNodeTitle: "世界模型",
  },
  {
    at: 63,
    durationSec: 5,
    text: "训练世界模型的代价是仿真环境与真实环境之间的差距。",
    nodeTitle: "仿真到真实差距",
    parentNodeTitle: "世界模型",
  },
  {
    at: 74,
    durationSec: 5,
    text: "演讲者认为评估世界模型的关键是一致性与可预测性。",
    nodeTitle: "一致性评估",
    parentNodeTitle: "世界模型",
  },
];

export const MOCK_PARTIAL_STEPS = 3;

/** Speech-time length of one full pass, so a second pass can start where the first ended. */
export const MOCK_SCRIPT_SPAN_SEC = MOCK_SCRIPT.reduce(
  (span, line) => Math.max(span, line.at + line.durationSec),
  0,
);

/**
 * A segment index counts up across passes (`MOCK_STT_REPEAT`), while the script itself repeats.
 * Both ends of the mock need this: the player to offset the clock, the scripted model to know which
 * pass a line belongs to.
 */
export function scriptLine(index: number): { line: MockLine; pass: number } | undefined {
  const line = MOCK_SCRIPT[index % MOCK_SCRIPT.length];
  if (!line) return undefined;
  return { line, pass: Math.floor(index / MOCK_SCRIPT.length) };
}

/**
 * Node titles must stay unique per pass or a long run stops growing the map — which is precisely the
 * thing Test F is watching for. Pass 0 keeps the bare title so every existing assertion still reads
 * 「世界模型」.
 */
export function scriptNodeTitle(line: MockLine, pass: number): string {
  return pass === 0 ? line.nodeTitle : `${line.nodeTitle}·${pass + 1}`;
}

/** Ids are scoped to the session, exactly as a real engine's ids would be, so two recordings cannot share rows. */
export function mockSegmentId(sessionId: string, lineIndex: number): string {
  return `${sessionId.slice(0, 8)}-mock-${lineIndex}`;
}
