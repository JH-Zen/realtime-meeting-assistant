import { describe, expect, it } from "vitest";
import { answerBody, linkLabel } from "../src/format";

describe("answerBody", () => {
  it("shows the tokens the model actually sent", () => {
    expect(answerBody({ text: "因为要预测后果", done: false })).toEqual({ tone: "answer", text: "因为要预测后果" });
  });

  it("waits only while the question is still open", () => {
    expect(answerBody({ text: "", done: false })).toEqual({ tone: "pending", text: "等待回答…" });
  });

  it("names a gate refusal with the server's own reason", () => {
    expect(answerBody({ text: "", done: true, reject: { message: "提问太密集，请 2 秒后再问" } }).text).toContain(
      "提问太密集",
    );
  });

  // The fault run found this: an empty `degraded` answer used to read as a connection loss, sending
  // the user off to check a network that was fine.
  it("does not blame the connection when the model is what failed", () => {
    const body = answerBody({ text: "", done: true, degraded: true });
    expect(body.tone).toBe("notice");
    expect(body.text).toContain("模型");
    expect(body.text).not.toContain("连接");
  });

  it("still blames the outage when nothing reported a failure", () => {
    expect(answerBody({ text: "", done: true }).text).toContain("连接中断");
  });
});

describe("linkLabel", () => {
  it("separates a first dial from a retry", () => {
    expect(linkLabel("connecting", 0)).toBe("连接中");
    expect(linkLabel("connecting", 2)).toBe("重连中（第 3 次尝试）");
    expect(linkLabel("closed", 2)).toBe("已断开（已重试 2 次）");
  });

  it("resets after a good connection", () => {
    expect(linkLabel("open", 4)).toBe("已连接");
    expect(linkLabel("closed", 0)).toBe("未连接");
  });
});
