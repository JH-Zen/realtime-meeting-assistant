import type { z } from "zod";
import {
  MOCK_SCRIPT,
  type MockLine,
  scriptLine,
  scriptNodeTitle,
} from "../testing/mockScript.js";
import { LLMStructuredOutputError, type LLMProvider, type LLMRequest, type LLMResult, type Structured } from "./LLMProvider.js";

/**
 * Mock LLM (§50). It parses the same prompt a real model receives, which doubles as a check that
 * the prompt carries everything needed, and it emits operations from the shared mock script so
 * `MOCK_STT=true MOCK_LLM=true` grows a deterministic tree with no API key.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";

  async generate(request: LLMRequest): Promise<LLMResult> {
    const started = Date.now();
    const text = request.task === "qa" ? mockAnswer(request) : JSON.stringify(this.structuredOutput(request));
    return {
      text,
      responseId: `mock-${Date.now()}-${request.task}`,
      inputTokens: estimateTokens(request.system + request.user),
      outputTokens: estimateTokens(text),
      latencyMs: Date.now() - started,
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    const full = request.task === "qa" ? mockAnswer(request) : "";
    for (let taken = 1; taken <= full.length; taken++) yield full.slice(0, taken);
  }

  async structuredGenerate<T>(request: LLMRequest, schema: z.ZodType<T>): Promise<Structured<T>> {
    const started = Date.now();
    const raw = this.structuredOutput(request);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMStructuredOutputError(
        `mock output rejected: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        1,
        JSON.stringify(raw),
      );
    }
    return {
      data: parsed.data,
      responseId: `mock-${started}-${request.task}`,
      latencyMs: Date.now() - started,
      inputTokens: estimateTokens(request.system + request.user),
      outputTokens: estimateTokens(JSON.stringify(raw)),
    };
  }

  private structuredOutput(request: LLMRequest): unknown {
    return request.task === "summary" ? mockSummary(request) : { operations: this.mindmapOps(request) };
  }

  private mindmapOps(request: LLMRequest): unknown[] {
    const existing = parseNodes(request.user);
    const batchIds = parseBatchIds(request.user);
    const operations: unknown[] = [];
    const createdInBatch = new Map<string, string>();

    for (const [title, id] of existing) if (!createdInBatch.has(title)) createdInBatch.set(title, id);

    for (const segmentId of batchIds) {
      const found = findLine(segmentId);
      if (!found) continue;
      const { line, pass } = found;
      const title = scriptNodeTitle(line, pass);
      if (existing.has(title)) continue;

      const newId = nodeIdFor(line, pass);
      const parentTitle = line.parentNodeTitle;
      let parentId: string | undefined;
      if (parentTitle) {
        // Parents are addressed by the same pass-suffixed title the child carries, so pass 2 builds
        // its own branch instead of hanging under pass 1's.
        const known = createdInBatch.get(`${parentTitle}${pass === 0 ? "" : `·${pass + 1}`}`);
        if (known) {
          parentId = known;
        } else {
          const parentLine = MOCK_SCRIPT.find((candidate) => candidate.nodeTitle === parentTitle);
          if (!parentLine) continue;
          const parentNewId = nodeIdFor(parentLine, pass);
          operations.push({
            type: "add_node",
            node: {
              id: parentNewId,
              title: scriptNodeTitle(parentLine, pass),
              summary: nodeSummary(parentLine),
              sourceTranscriptIds: [segmentId],
              ...(parentLine.parentNodeTitle
                ? { parentId: createdInBatch.get(`${parentLine.parentNodeTitle}${pass === 0 ? "" : `·${pass + 1}`}`) }
                : {}),
            },
          });
          createdInBatch.set(scriptNodeTitle(parentLine, pass), parentNewId);
          parentId = parentNewId;
        }
      }

      operations.push({
        type: "add_node",
        node: {
          id: newId,
          title,
          summary: nodeSummary(line),
          sourceTranscriptIds: [segmentId],
          ...(parentId ? { parentId } : {}),
        },
      });
      createdInBatch.set(title, newId);
    }

    return operations;
  }
}

/** Segment ids count up across repeated passes of the script, which is what a long run replays. */
function findLine(segmentId: string): { line: MockLine; pass: number } | undefined {
  const index = Number(segmentId.slice(segmentId.lastIndexOf("-") + 1));
  return Number.isInteger(index) && index >= 0 ? scriptLine(index) : undefined;
}

/**
 * The MindMap prompt asks for one summary per node (§13 OPEN-8), so the mock supplies the shape a
 * real model would return: the line the node came from, clamped to the 40 字 the prompt names.
 */
function nodeSummary(line: MockLine): string {
  return line.text.slice(0, 40);
}

/** `id=n-abc | title=世界模型` lines, as rendered by the MindMap prompt. */
function parseNodes(user: string): Map<string, string> {
  const out = new Map<string, string>();
  const section = user.split("### 当前相关节点")[1]?.split("### 本批转写")[0] ?? "";
  for (const match of section.matchAll(/id=(\S+)\s*\|\s*title=([^\n|]+)/g)) {
    const [, id, title] = match;
    if (id && title) out.set(title.trim(), id);
  }
  return out;
}

function parseBatchIds(user: string): string[] {
  const section = user.split("### 本批转写")[1]?.split("请只针对本批转写")[0] ?? "";
  return [...section.matchAll(/id=(\S+)\s*\|/g)].map((match) => match[1]).filter((v): v is string => Boolean(v));
}

function mockAnswer(request: LLMRequest): string {
  const question = request.user.split("### 问题")[1]?.trim() ?? "";
  const hot = answerLines(
    sliceSection(request.user, "### 最近转写（热上下文）", "### 检索到的历史转写"),
  );
  // The mock quotes its single best retrieved line, so a test can assert which one the index ranked
  // first. With nothing retrieved the answer is byte-identical to the Hot-Context-only behaviour.
  const archived = answerLines(
    sliceSection(request.user, "### 检索到的历史转写", "### 问题"),
  );
  const evidence = [...hot.slice(-2), ...archived.slice(0, 1)].join(" ");
  return `关于「${question}」：${evidence || "目前转写中没有提到相关内容。"}\n\n（Mock 模式回答，未调用真实模型。）`;
}

function sliceSection(user: string, start: string, end: string): string {
  return user.split(start)[1]?.split(end)[0] ?? "";
}

function answerLines(section: string): string[] {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("["));
}

function mockSummary(request: LLMRequest): { summary: string; keyPoints: string[]; entities: string[] } {
  const isMerge = request.user.includes("### 待合并的阶段摘要");
  const section =
    (isMerge
      ? request.user.split("### 待合并的阶段摘要")[1]
      : request.user.split("### 本阶段转写")[1]) ?? "";
  const texts = [...section.matchAll(/\]\s(.+)$/gm)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((text) => text.length > 0 && !text.startsWith("要点"));

  const head = texts[0] ?? "";
  const tail = texts.at(-1) ?? "";
  const label = isMerge ? "以下阶段合并" : "本阶段";
  const summary =
    texts.length === 0
      ? `${label}没有可摘要的内容。`
      : texts.length === 1
        ? `${label}共 1 条：${clip(head)}。`
        : `${label}共 ${texts.length} 条，从「${clip(head)}」展开，收束于「${clip(tail)}」。`;

  const terms = new Set(MOCK_SCRIPT.map((line) => line.nodeTitle));
  const joined = texts.join("");
  return {
    summary,
    keyPoints: texts.slice(0, 3).map(clip),
    entities: [...terms].filter((term) => term && joined.includes(term)).slice(0, 6),
  };
}

/** Prompts ask for key points under 30 characters; the mock holds the same line. */
function clip(text: string): string {
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

function slug(title: string): string {
  return Buffer.from(title, "utf8").toString("hex").slice(0, 10);
}

/**
 * The slug is only 10 hex chars, and 「世界模型」 and 「世界模型·2」 share their first fifteen — a slug
 * of the suffixed title would hand the second pass the first pass's id, the graph gate would drop it
 * as a duplicate, and a long run would silently stop growing.
 */
function nodeIdFor(line: MockLine, pass: number): string {
  return `n-${slug(line.nodeTitle)}${pass === 0 ? "" : `-p${pass + 1}`}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}
