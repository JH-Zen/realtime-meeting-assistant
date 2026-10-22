import { describe, expect, it } from "vitest";
import type {
  AnswerCompleted,
  AnswerRejected,
  AnswerStarted,
  AnswerToken,
  ModuleError,
  TranscriptSegment,
} from "@rcc/shared";
import { graphReadView, parseGraphOperations } from "@rcc/shared";
import type { z } from "zod";
import { createBus } from "../src/bus/eventBus.js";
import type { BackendConfig } from "../src/config/env.js";
import { GraphStore } from "../src/graph/GraphStore.js";
import { openSqlite } from "../src/store/sqlite.js";
import { SqliteGraphRepository } from "../src/store/graphRepository.js";
import { SqliteSessionRepository } from "../src/store/sessionRepository.js";
import { SqliteTranscriptRepository } from "../src/store/transcriptRepository.js";
import { SqliteQaRepository } from "../src/store/qaRepository.js";
import type { QaRecorder } from "../src/store/qaRepository.js";
import { TranscriptCore } from "../src/transcript/TranscriptCore.js";
import { QaCore } from "../src/qa/QaCore.js";
import type { LLMProvider, LLMRequest, LLMResult, Structured } from "../src/llm/LLMProvider.js";
import { makeConfig, segment, tick } from "./helpers.js";

/**
 * QA is the only module whose output is a *stream* the user watches, so these tests hold the three
 * promises the contract makes: cumulative tokens, a context that cannot mutate mid-answer (§32), and
 * citations that only ever point at lines the model was actually given (§33).
 */

class ScriptedLLM implements LLMProvider {
  readonly name = "scripted";
  lastRequest: LLMRequest | null = null;
  streams = 0;

  constructor(
    private readonly deltas: string[],
    private readonly opts: { delayMs?: number; failAfter?: number } = {},
  ) {}

  async generate(): Promise<LLMResult> {
    return { text: this.deltas.join(""), responseId: "gen", inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  }

  async *stream(request: LLMRequest): AsyncIterable<string> {
    this.lastRequest = request;
    this.streams += 1;
    let text = "";
    for (const [index, delta] of this.deltas.entries()) {
      if (this.opts.delayMs) await new Promise((resolve) => setTimeout(resolve, this.opts.delayMs));
      if (this.opts.failAfter !== undefined && index >= this.opts.failAfter) throw new Error("429 rate limited");
      text += delta;
      yield text;
    }
  }

  async structuredGenerate<T>(_request: LLMRequest, _schema: z.ZodType<T>): Promise<Structured<T>> {
    return { data: {} as T, responseId: "stub", latencyMs: 0, inputTokens: 0, outputTokens: 0 };
  }
}

function setup(
  deltas: string[],
  opts: { delayMs?: number; failAfter?: number } = {},
  hotContextSec = 60,
  overview = "",
  /** §30 index lookup; the production wiring hands QA a function, never the module. */
  search: (question: string, excludeIds: ReadonlySet<string>) => Promise<TranscriptSegment[]> = async () => [],
  /** Admission knobs, so a test can raise one gate without touching the other. */
  config: Partial<BackendConfig> = {},
  /** Swap the storage out to test what a failing history write does to the answer. */
  recorder?: QaRecorder,
) {
  const llm = new ScriptedLLM(deltas, opts);
  const qaConfig = makeConfig({ hotContextSec, ...config });
  const store = openSqlite(":memory:");
  new SqliteSessionRepository(store.db).create({ id: "s1", startedAt: 1, status: "recording" });
  const bus = createBus();
  const transcripts = new SqliteTranscriptRepository(store.db);
  const transcript = new TranscriptCore(bus, transcripts);
  const graph = new GraphStore(bus, new SqliteGraphRepository(store.db), "s1");
  const history = new SqliteQaRepository(store.db);
  const qa = new QaCore(
    bus,
    transcript,
    graph,
    llm,
    qaConfig,
    "s1",
    recorder ?? history,
    () => overview,
    search,
  );
  const completed: AnswerCompleted[] = [];
  const started: AnswerStarted[] = [];
  const tokens: AnswerToken[] = [];
  const rejected: AnswerRejected[] = [];
  const errors: ModuleError[] = [];
  bus.on("qa", "answer.started", (payload) => {
    started.push(payload);
  });
  bus.on("qa", "answer.token", (payload) => {
    tokens.push(payload);
  });
  bus.on("qa", "answer.completed", (payload) => {
    completed.push(payload);
  });
  bus.on("qa", "answer.rejected", (payload) => {
    rejected.push(payload);
  });
  bus.onError((error) => errors.push(error));
  return { llm, bus, transcript, graph, qa, started, tokens, completed, rejected, errors, store };
}

/** Three lines at 0s, 10s, 20s; a 60s window keeps all of them. */
const speak = (r: ReturnType<typeof setup>) => {
  r.transcript.acceptFinal(segment("t-0", "今天讨论世界模型。", 0));
  r.transcript.acceptFinal(segment("t-1", "世界模型能预测下一个状态。", 10));
  r.transcript.acceptFinal(segment("t-2", "仿真与真实之间存在差距。", 20));
};

describe("QA core", () => {
  it("streams cumulative tokens and finishes with the same text", async () => {
    const r = setup(["世界模型", "能预测下一个状态", " [00:10]。"]);
    speak(r);

    await r.qa.ask("q1", "世界模型能做什么？");

    expect(r.tokens.map((token) => token.text)).toEqual([
      "世界模型",
      "世界模型能预测下一个状态",
      "世界模型能预测下一个状态 [00:10]。",
    ]);
    expect(r.completed[0]?.text).toBe("世界模型能预测下一个状态 [00:10]。");
    expect(r.completed[0]?.degraded).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it("cites only the lines that were in the frozen context", async () => {
    const r = setup(["见 [00:10] 与 [00:20]，另有 [99:00] 是编的。"]);
    speak(r);

    await r.qa.ask("q1", "引用来源。");

    expect(r.completed[0]?.citations).toEqual([
      { transcriptId: "t-1", startTime: 10 },
      { transcriptId: "t-2", startTime: 20 },
    ]);
  });

  it("freezes the context, so speech arriving mid-answer cannot change the basis", async () => {
    const r = setup(["第一", "第二", "第三"], { delayMs: 10 });
    speak(r);

    const asking = r.qa.ask("q1", "刚才说了什么？");
    r.transcript.acceptFinal(segment("late", "回答开始后才到的一句。", 30));
    await asking;

    expect(r.llm.lastRequest?.user).not.toContain("回答开始后才到的一句。");
    expect(r.llm.lastRequest?.user).toContain("仿真与真实之间存在差距。");
    expect(r.llm.lastRequest?.task).toBe("qa");
  });

  it("sends the snapshot id before any token, and the same question id throughout", async () => {
    const r = setup(["答案。"]);
    speak(r);

    await r.qa.ask("q-42", "问题。");

    expect(r.started).toHaveLength(1);
    expect(r.started[0]?.questionId).toBe("q-42");
    expect(r.started[0]?.snapshotId).toMatch(/-/);
    expect(r.tokens.every((token) => token.questionId === "q-42")).toBe(true);
    expect(r.completed[0]?.questionId).toBe("q-42");
  });

  it("degrades instead of throwing, and leaves the transcript intact", async () => {
    const r = setup(["前半句", "更多"], { failAfter: 1 });
    speak(r);

    await expect(r.qa.ask("q1", "会失败的问题。")).resolves.toBeUndefined();

    expect(r.completed[0]?.degraded).toBe(true);
    expect(r.completed[0]?.text).toBe("前半句");
    expect(r.errors.map((error) => [error.module, error.code])).toEqual([["qa", "answer_failed"]]);
  });

  it("bounds concurrency instead of letting a client pile up requests", async () => {
    const r = setup(["a", "b", "c"], { delayMs: 8 });
    speak(r);

    const first = r.qa.ask("q1", "第一个问题。");
    const second = r.qa.ask("q2", "第二个问题。");
    await r.qa.ask("q3", "第三个问题。");
    await Promise.all([first, second]);
    await tick();

    expect(r.llm.streams).toBe(2);
    expect(r.rejected.map((refusal) => [refusal.questionId, refusal.reason])).toEqual([["q3", "busy"]]);
    // A refusal is an admission decision, not a fault: the error channel stays clean so a real QA
    // failure is still findable in the debug panel.
    expect(r.errors).toEqual([]);
    expect(r.started.map((start) => start.questionId)).toEqual(["q1", "q2"]);
  });

  it("refuses a second question that arrives inside the minimum interval", async () => {
    const r = setup(["答。"], {}, 60, "", async () => [], { qa: { minIntervalMs: 500 } });
    speak(r);

    await r.qa.ask("q1", "第一个问题。");
    await r.qa.ask("q2", "紧接着又按了一次回车。");
    await tick();

    expect(r.llm.streams).toBe(1);
    expect(r.completed).toHaveLength(1);
    expect(r.rejected.map((refusal) => [refusal.questionId, refusal.reason])).toEqual([["q2", "rate_limited"]]);
    expect(r.rejected[0]?.retryAfterMs).toBeGreaterThan(0);
    expect(r.rejected[0]?.retryAfterMs).toBeLessThanOrEqual(500);
    expect(r.rejected[0]?.message).toContain("秒");
  });

  it("lets a question through once the interval has passed", async () => {
    const r = setup(["答。"], {}, 60, "", async () => [], { qa: { minIntervalMs: 20 } });
    speak(r);

    await r.qa.ask("q1", "第一个问题。");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await r.qa.ask("q2", "等过间隔之后重问。");

    expect(r.llm.streams).toBe(2);
    expect(r.rejected).toEqual([]);
    expect(r.completed).toHaveLength(2);
  });

  it("refuses before any of the expensive work, so spam cannot become a bill", async () => {
    // The cost of a question is the context snapshot plus one query embedding (§3), so the gate has
    // to run first — a refusal that embeds and then says "no" saves nothing.
    let searches = 0;
    const r = setup(["答。"], {}, 60, "", async () => {
      searches += 1;
      return [];
    }, { qa: { minIntervalMs: 10_000 } });
    speak(r);

    await r.qa.ask("q1", "第一个问题。");
    await Promise.all([r.qa.ask("q2", "连击。"), r.qa.ask("q3", "连击。"), r.qa.ask("q4", "连击。")]);

    expect(searches).toBe(1);
    expect(r.llm.streams).toBe(1);
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected.every((refusal) => refusal.reason === "rate_limited")).toBe(true);
  });

  it("stops emitting into a session that has been disposed", async () => {
    const r = setup(["慢慢", "说完"], { delayMs: 8 });
    speak(r);

    const asking = r.qa.ask("q1", "会话结束前的问题。");
    r.qa.close();
    await asking;

    expect(r.tokens).toEqual([]);
    expect(r.completed).toEqual([]);
  });

  it("does not open an answer for a session that ended while the index was queried", async () => {
    // Retrieval is the first thing QA awaits, so it is where a stop lands in the middle of a question.
    // Continuing past that point emitted `answer.started` — a promise of streamed text with no client
    // and no session behind it — and then spent the model call.
    const r = setup(["答。"], {}, 60, "", () => {
      return new Promise<TranscriptSegment[]>((resolve) => {
        setTimeout(() => {
          r.qa.close();
          resolve([]);
        }, 5);
      });
    });
    speak(r);

    await r.qa.ask("q1", "检索还没回来，会话就停了。");

    expect(r.started).toEqual([]);
    expect(r.llm.streams).toBe(0);
    expect(r.completed).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("does not report a QA failure to a session that has already ended", async () => {
    // The stream dying after `close()` is the recording being cancelled, not the answer module
    // failing. The row still goes into history (it is what was answered), but the live channels stay
    // shut — otherwise a new client sees `answer_failed` for a session it never joined.
    // `failAfter: 0` is what makes this the failure path: with any other budget the first chunk
    // arrives, the loop's own closed check breaks out, and the catch below never runs.
    const r = setup(["前半句", "更多"], { failAfter: 0, delayMs: 20 });
    speak(r);

    const asking = r.qa.ask("q-fail", "会话结束之后才断的流。");
    await new Promise((resolve) => setTimeout(resolve, 5));
    r.qa.close();
    await asking;

    expect(r.errors).toEqual([]);
    expect(r.completed).toEqual([]);
    const row = r.store.db
      .prepare("SELECT degraded FROM answers WHERE question_id = ?")
      .get("q-fail") as unknown as { degraded: number } | undefined;
    expect(row?.degraded).toBe(1);
  });

  it("records an answer cut short by stopping the recording as what it was", async () => {
    // The other way a stop lands: the stream breaks on its own closed check, so the success path runs
    // with half a sentence in hand. `degraded` was the tempting label and it is a lie — `format.ts`
    // renders a degraded row as "模型没能给出这一题的回答", and here the model was still talking.
    // Pinned so neither the row nor the flag can drift without a test noticing.
    const r = setup(["前半句", "后半句"], { delayMs: 20 });
    speak(r);

    const asking = r.qa.ask("q-cut", "回答说到一半，录音停了。");
    await new Promise((resolve) => setTimeout(resolve, 30));
    r.qa.close();
    await asking;

    expect(r.tokens.map((token) => token.text)).toEqual(["前半句"]);
    expect(r.completed).toEqual([]);
    expect(r.errors).toEqual([]);
    const row = r.store.db
      .prepare("SELECT text, degraded FROM answers WHERE question_id = ?")
      .get("q-cut") as unknown as { text: string; degraded: number } | undefined;
    expect(row?.text).toBe("前半句");
    expect(row?.degraded).toBe(0);
  });

  it("renders the prompt with the nodes it has and the retrieval slots still empty", async () => {
    const r = setup(["答。"]);
    speak(r);
    const seeded = parseGraphOperations(
      [{ type: "add_node", node: { id: "n-world", title: "世界模型", sourceTranscriptIds: ["t-0"] } }],
      graphReadView(r.graph.graphState),
      { responseId: "seed", now: 1 },
    );
    r.graph.applyOps(seeded.accepted, "seed");

    await r.qa.ask("q1", "有什么节点？");

    const user = r.llm.lastRequest?.user ?? "";
    expect(user).toContain("### 最近转写（热上下文）");
    expect(user).toContain("### 检索到的历史转写\n(暂无)");
    expect(user).toContain("- 世界模型");
    expect(user).toContain("### 问题\n有什么节点？");
    // Until Memory has a block, the overview section says so rather than being omitted.
    expect(user).toContain("### 全局摘要\n(会议刚开始，还没有阶段摘要)");
  });

  it("folds the memory overview into the same frozen snapshot", async () => {
    const r = setup(["答。"], {}, 60, "【整体 00:00-04:00】世界模型更适合长期规划。");
    speak(r);

    await r.qa.ask("q1", "整体讲了什么？");

    expect(r.llm.lastRequest?.user).toContain("### 全局摘要\n【整体 00:00-04:00】世界模型更适合长期规划。");
  });

  it("freezes retrieved history into the answer, and lets it be cited", async () => {
    // Test D: the line the user asks about has already scrolled out of Hot Context, so the only way
    // it can reach the answer — and carry a citation — is through the index.
    const archived = segment("old-1", "世界模型是对环境动态的内部预测。", 5);
    const exclusions: string[][] = [];
    const r = setup(["世界模型是对环境动态的内部预测 [00:05]。"], {}, 60, "", async (_question, ids) => {
      exclusions.push([...ids]);
      return [archived];
    });
    speak(r);

    await r.qa.ask("q1", "他是怎么定义世界模型的？");

    expect(r.llm.lastRequest?.user).toContain("### 检索到的历史转写\n[00:05] 世界模型是对环境动态的内部预测。");
    expect(exclusions[0]).toEqual(["t-0", "t-1", "t-2"]);
    expect(r.completed[0]?.citations).toEqual([{ transcriptId: "old-1", startTime: 5 }]);
  });

  it("still answers, and stays answerable, when the index throws", async () => {
    const r = setup(["世界模型能预测下一个状态 [00:10]。"], {}, 60, "", async () => {
      throw new Error("index down");
    });
    speak(r);

    await r.qa.ask("q1", "刚才说了什么？");

    // Retrieval is an enhancement: the question is answered out of Hot Context and no error reaches
    // the UI as a QA failure.
    expect(r.completed[0]?.degraded).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.llm.lastRequest?.user).toContain("### 检索到的历史转写\n(暂无)");

    // The concurrency counter must have been released, or the next question would be refused as `busy`.
    await r.qa.ask("q2", "再问一次。");
    expect(r.completed).toHaveLength(2);
    expect(r.llm.streams).toBe(2);
  });

  it("records the question and the answer it produced, citations included", async () => {
    // §40: the history tables are only real if the live path writes them. An answer that streams and
    // then evaporates cannot be re-read after a reload, which is what OPEN-4 was.
    const r = setup(["世界模型能预测下一个状态 [00:10]。"]);
    speak(r);

    await r.qa.ask("q-hist", "世界模型能做什么？");

    const questions = r.store.db
      .prepare("SELECT id, session_id, text, created_at, snapshot_id FROM questions WHERE id = ?")
      .all("q-hist") as unknown as {
      id: string;
      session_id: string;
      text: string;
      created_at: number;
      snapshot_id: string;
    }[];
    expect(questions).toHaveLength(1);
    expect(questions[0]?.session_id).toBe("s1");
    expect(questions[0]?.text).toBe("世界模型能做什么？");
    expect(questions[0]?.snapshot_id).toBe(r.started[0]?.snapshotId);

    const answers = r.store.db
      .prepare("SELECT question_id, text, citations, duration_ms, degraded FROM answers WHERE question_id = ?")
      .all("q-hist") as unknown as {
      question_id: string;
      text: string;
      citations: string;
      duration_ms: number;
      degraded: number;
    }[];
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe("世界模型能预测下一个状态 [00:10]。");
    expect(JSON.parse(answers[0]?.citations ?? "null")).toEqual([{ transcriptId: "t-1", startTime: 10 }]);
    expect(answers[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(answers[0]?.degraded).toBe(0);
  });

  it("records a degraded answer as degraded rather than dropping it", async () => {
    const r = setup(["前半句", "更多"], { failAfter: 1 });
    speak(r);

    await r.qa.ask("q-fail", "会失败的问题。");

    const row = r.store.db
      .prepare("SELECT text, degraded, citations FROM answers WHERE question_id = ?")
      .get("q-fail") as unknown as { text: string; degraded: number; citations: string };
    expect(row.degraded).toBe(1);
    expect(row.text).toBe("前半句");
    expect(JSON.parse(row.citations)).toEqual([]);
  });

  it("writes no row for a question that was refused", async () => {
    // Refusal is decided before any work happens (§3), so it must not leave history behind either —
    // a list of questions that were never answered would make the rate limit look like a bug.
    const r = setup(["答。"], {}, 60, "", async () => [], { qa: { minIntervalMs: 5_000 } });
    speak(r);

    await r.qa.ask("q-ok", "第一个问题。");
    await r.qa.ask("q-no", "紧接着又按了一次回车。");

    expect(r.store.db.prepare("SELECT id FROM questions").all()).toEqual([{ id: "q-ok" }]);
    expect(r.store.db.prepare("SELECT question_id FROM answers").all()).toEqual([{ question_id: "q-ok" }]);
  });

  it("keeps the answer the user watched when the history write fails", async () => {
    // Storage is a side effect of answering, not a precondition: an unwritten row must not turn a
    // correct streamed answer into a `degraded` one, and must not look like an LLM failure either.
    const throwing: QaRecorder = {
      recordQuestion: () => {
        throw new Error("disk full");
      },
      recordAnswer: () => {
        throw new Error("disk full");
      },
    };
    const r = setup(["世界模型能预测下一个状态 [00:10]。"], {}, 60, "", async () => [], {}, throwing);
    speak(r);

    await r.qa.ask("q-1", "存储坏了还能答吗？");

    expect(r.completed[0]?.degraded).toBe(false);
    expect(r.completed[0]?.text).toBe("世界模型能预测下一个状态 [00:10]。");
    expect(r.errors).toEqual([]);
    // The throwing recorder really is the one QA writes through, or this test would prove nothing.
    expect(r.store.db.prepare("SELECT id FROM questions").all()).toEqual([]);
  });
});
