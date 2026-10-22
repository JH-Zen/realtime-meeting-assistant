import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "@rcc/shared";
import { livePartial, useSessionStore } from "../src/state/sessionStore";

/**
 * The client cannot tell a refused question from an answer that is still coming, because both look
 * like a bubble with no text in it — so `answer.rejected` is what keeps the panel honest, and it is
 * the only place a refusal lands. These tests hold that loop closed.
 */

const apply = (event: ServerEvent) => useSessionStore.getState().apply(event);
const answerFor = (questionId: string) => useSessionStore.getState().answers.find((a) => a.questionId === questionId);

describe("session store answers", () => {
  beforeEach(() => {
    useSessionStore.setState({ answers: [], askedAt: {}, errors: [], recording: "idle", sessionId: null });
    apply({ kind: "recording.started", sessionId: "s1", at: 1, source: "mock" });
  });

  it("closes the question when the server refuses it", () => {
    useSessionStore.getState().ask("q-1", "刚问的问题");

    apply({
      kind: "answer.rejected",
      sessionId: "s1",
      questionId: "q-1",
      reason: "rate_limited",
      message: "提问太密集，请 1 秒后再问",
      retryAfterMs: 900,
    });

    const answer = answerFor("q-1");
    expect(answer?.done).toBe(true);
    expect(answer?.text).toBe("");
    expect(answer?.reject?.reason).toBe("rate_limited");
    expect(answer?.reject?.message).toContain("秒");
    expect(answer?.reject?.retryAfterMs).toBe(900);
  });

  it("keeps a refusal out of the error list, because refusing is the gate working", () => {
    useSessionStore.getState().ask("q-1", "刚问的问题");
    apply({
      kind: "answer.rejected",
      sessionId: "s1",
      questionId: "q-1",
      reason: "busy",
      message: "已有 2 个问题在回答中，请稍后再问",
      retryAfterMs: 0,
    });

    expect(useSessionStore.getState().errors).toEqual([]);
  });

  it("leaves an answered question free of any refusal", () => {
    useSessionStore.getState().ask("q-1", "有回答的问题");
    apply({ kind: "answer.started", sessionId: "s1", questionId: "q-1", snapshotId: "snap-1", startedAt: 1 });
    apply({ kind: "answer.token", questionId: "q-1", text: "世界模型" });
    apply({
      kind: "answer.completed",
      sessionId: "s1",
      questionId: "q-1",
      text: "世界模型能预测下一个状态",
      citations: [{ transcriptId: "t-1", startTime: 10 }],
      durationMs: 120,
      degraded: false,
    });

    const answer = answerFor("q-1");
    expect(answer?.done).toBe(true);
    expect(answer?.reject).toBeUndefined();
    expect(answer?.text).toBe("世界模型能预测下一个状态");
  });

  it("drops the ask-time clock once the question settles", () => {
    useSessionStore.getState().ask("q-1", "在回答中的问题");
    expect(Object.keys(useSessionStore.getState().askedAt)).toEqual(["q-1"]);

    apply({ kind: "answer.token", questionId: "q-1", text: "世界模型" });
    apply({
      kind: "answer.completed",
      sessionId: "s1",
      questionId: "q-1",
      text: "世界模型能预测下一个状态",
      citations: [],
      durationMs: 120,
      degraded: false,
    });
    expect(useSessionStore.getState().askedAt).toEqual({});

    // A refusal keeps nothing either: a question that will never stream has no clock to measure.
    useSessionStore.getState().ask("q-2", "被拒绝的问题");
    apply({
      kind: "answer.rejected",
      sessionId: "s1",
      questionId: "q-2",
      reason: "busy",
      message: "已有 2 个问题在回答中，请稍后再问",
      retryAfterMs: 0,
    });
    expect(useSessionStore.getState().askedAt).toEqual({});
  });

  it("only closes the question that was refused", () => {
    useSessionStore.getState().ask("q-1", "在回答中的问题");
    useSessionStore.getState().ask("q-2", "被拒绝的问题");
    apply({ kind: "answer.token", questionId: "q-1", text: "世界模型" });
    apply({
      kind: "answer.rejected",
      sessionId: "s1",
      questionId: "q-2",
      reason: "rate_limited",
      message: "提问太密集，请 1 秒后再问",
      retryAfterMs: 1000,
    });

    expect(answerFor("q-1")?.done).toBe(false);
    expect(answerFor("q-1")?.reject).toBeUndefined();
    expect(answerFor("q-2")?.done).toBe(true);
  });
});

describe("session store partials", () => {
  const partial = (id: string, text: string): ServerEvent => ({
    kind: "transcript.partial",
    segment: { id, sessionId: "s1", text, startTime: 0, createdAt: 0, type: "partial" },
  });

  beforeEach(() => {
    useSessionStore.setState({ partials: {}, finals: [] });
    apply({ kind: "recording.started", sessionId: "s1", at: 1, source: "mic" });
  });

  it("drops the in-flight line when the recogniser goes away", () => {
    // The worker numbers segments with a counter it re-bases on every reconnect, so a partial that was
    // mid-utterance when the link died can never receive its final. Left in place it stays as the live
    // subtitle line — a sentence still being heard, minutes after the engine stopped.
    apply(partial("s1-live-3", "世界模型可"));
    expect(livePartial(useSessionStore.getState().partials)).toBe("世界模型可");

    apply({ kind: "stt.status", sessionId: "s1", state: "reconnecting", attempts: 1, message: "识别引擎已断开" });

    expect(useSessionStore.getState().partials).toEqual({});
    expect(livePartial(useSessionStore.getState().partials)).toBe("");
  });

  it("keeps a partial that arrives after the recogniser came back", () => {
    apply({ kind: "stt.status", sessionId: "s1", state: "failed", attempts: 2, message: "识别引擎重连失败" });
    apply(partial("s1-live-9", "重连之后的半句"));

    expect(useSessionStore.getState().stt.message).toBe("识别引擎重连失败");
    expect(livePartial(useSessionStore.getState().partials)).toBe("重连之后的半句");
  });
});
