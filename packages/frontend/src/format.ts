export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * A dropped socket must not look like an idle app: `attempts` counts the dials that have failed since
 * the last good connection, which is the difference between "还没连上" and "已经重试过 4 次".
 */
export function linkLabel(link: "connecting" | "open" | "closed", attempts: number): string {
  if (link === "open") return "已连接";
  if (attempts <= 0) return link === "connecting" ? "连接中" : "未连接";
  return link === "connecting" ? `重连中（第 ${attempts + 1} 次尝试）` : `已断开（已重试 ${attempts} 次）`;
}

/**
 * "Finished with nothing in it" has three different causes and must not read as one of them:
 * the gate refused the question, the model failed to answer it (`degraded`, §44), or the answer
 * completed while the socket was down. Only the middle one is the server's own report.
 */
export function answerBody(answer: {
  text: string;
  done: boolean;
  degraded?: boolean;
  reject?: { message: string };
}): { tone: "notice" | "answer" | "pending"; text: string } {
  if (answer.reject) return { tone: "notice", text: answer.reject.message };
  if (answer.text) return { tone: "answer", text: answer.text };
  if (answer.degraded) return { tone: "notice", text: "模型没能给出这一题的回答，请重试。" };
  if (answer.done) return { tone: "notice", text: "连接中断时这一题的回答没能送达，请重新提问。" };
  return { tone: "pending", text: "等待回答…" };
}
