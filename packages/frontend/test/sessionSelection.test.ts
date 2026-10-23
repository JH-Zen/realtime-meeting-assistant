import { beforeEach, describe, expect, it } from "vitest";
import type { MindMapNode, ServerEvent, TranscriptSegment } from "@rcc/shared";
import { dispatchEvent } from "../src/net/dispatch";
import { useSessionStore } from "../src/state/sessionStore";
import { useGraphStore } from "../src/state/graphStore";

const node: MindMapNode = { id: "same-node-id", title: "原文导图", sourceTranscriptIds: [], createdAt: 0, updatedAt: 0 };
const final = (sessionId: string): TranscriptSegment => ({ id: "same-transcript-id", sessionId, text: `${sessionId}原文`, startTime: 0, endTime: 2, type: "final", createdAt: 1 });
function select(sessionId?: string) {
  dispatchEvent({ kind: "session.snapshot", ...(sessionId ? { sessionId } : {}), state: sessionId ? "viewing" : "idle", elapsedSec: 0, stt: "idle", serverTime: 1 });
}
const session = () => useSessionStore.getState();
const graph = () => useGraphStore.getState();

describe("session selection is a full replacement (M2)", () => {
  beforeEach(() => { select(); select("s1"); });

  it("clears text, answers, errors, STT, and graph when the meeting is explicitly closed", () => {
    dispatchEvent({ kind: "transcript.final", segment: final("s1") });
    dispatchEvent({ kind: "graph.snapshot", sessionId: "s1", nodes: [node], edges: [], positions: {} });
    session().ask("q-old", "旧问题");
    dispatchEvent({ kind: "module.error", module: "stt", code: "old", message: "旧错误", at: 1, recoverable: true });
    dispatchEvent({ kind: "stt.status", sessionId: "s1", state: "failed", attempts: 2 });
    select();
    expect(session()).toMatchObject({ sessionId: null, finals: [], partials: {}, answers: [], askedAt: {}, errors: [], bufferedSkips: 0, elapsedSec: 0, stt: { state: "idle" } });
    expect(graph().graph.nodes).toEqual({});
    expect(graph().positions).toEqual({});
  });

  it("does not carry pins/collapse state to a different meeting with the same node ids", () => {
    dispatchEvent({ kind: "graph.snapshot", sessionId: "s1", nodes: [node], edges: [], positions: { [node.id]: { x: 900, y: 800 } } });
    graph().toggleCollapsed(node.id);
    select("s2");
    dispatchEvent({ kind: "graph.snapshot", sessionId: "s2", nodes: [node], edges: [], positions: {} });
    expect(graph().pinned).toEqual({});
    expect(graph().collapsed).toEqual({});
    expect(graph().positions[node.id]).not.toEqual({ x: 900, y: 800 });
  });

  it("ignores delayed old-session subtitles, graph updates, answers, and scoped errors", () => {
    session().ask("q-old", "旧问题");
    select("s2");
    const stale: ServerEvent[] = [
      { kind: "transcript.final", segment: final("s1") },
      { kind: "transcript.snapshot", sessionId: "s1", segments: [final("s1")] },
      { kind: "graph.snapshot", sessionId: "s1", nodes: [node], edges: [], positions: {} },
      { kind: "mindmap.updated", sessionId: "s1", responseId: "old-response", operations: [{ type: "add_node", opId: "old-op", node }], touchedNodeIds: [node.id], durationMs: 1 },
      { kind: "answer.started", sessionId: "s1", questionId: "q-old", snapshotId: "snapshot", startedAt: 1 },
      { kind: "answer.token", sessionId: "s1", questionId: "q-old", text: "旧答案" },
      { kind: "answer.token", questionId: "q-old", text: "旧服务器无归属的答案" },
      { kind: "answer.completed", sessionId: "s1", questionId: "q-old", text: "旧答案", citations: [], durationMs: 1, degraded: false },
      { kind: "module.error", sessionId: "s1", module: "retrieval", code: "old-search", message: "旧检索错误", at: 1, recoverable: true },
    ];
    for (const event of stale) dispatchEvent(event);
    expect(session().finals).toEqual([]);
    expect(session().answers).toEqual([]);
    expect(session().errors).toEqual([]);
    expect(graph().graph.nodes).toEqual({});
  });

  it("replaces same-session finals on reconnect and recovers an answer completed while disconnected", () => {
    dispatchEvent({ kind: "transcript.final", segment: final("s1") });
    session().ask("q1", "已保存问题");
    select("s1");
    dispatchEvent({ kind: "transcript.snapshot", sessionId: "s1", segments: [final("s1")] });
    dispatchEvent({ kind: "answers.snapshot", sessionId: "s1", pendingQuestionIds: [], exchanges: [{ question: { id: "q1", text: "已保存问题", createdAt: 1, snapshotId: "snap" }, answer: { questionId: "q1", text: "断线期间已保存的完整答案", citations: [], durationMs: 10, degraded: false, createdAt: 2 } }] });
    expect(session().finals).toHaveLength(1);
    expect(session().answers).toMatchObject([{ questionId: "q1", question: "已保存问题", text: "断线期间已保存的完整答案", done: true }]);
    expect(session().askedAt).toEqual({});
  });

  it("distinguishes a live pending question from one interrupted by an earlier app exit", () => {
    dispatchEvent({ kind: "answers.snapshot", sessionId: "s1", pendingQuestionIds: ["live"], exchanges: ["live", "interrupted"].map((id) => ({ question: { id, text: id, createdAt: 1, snapshotId: "snap" }, answer: null })) });
    expect(session().answers.map((answer) => answer.done)).toEqual([false, true]);
    dispatchEvent({ kind: "answer.token", sessionId: "s1", questionId: "live", text: "继续回答" });
    expect(session().answers[0]?.text).toBe("继续回答");
    expect(session().answers[1]?.text).toBe("");
  });
});
