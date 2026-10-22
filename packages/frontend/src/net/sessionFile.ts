import { API_BASE } from "../config";
import { resyncFromServer } from "./connection";
import { useSessionStore, type Answer, type Citation } from "../state/sessionStore";

/**
 * The two HTTP surfaces that are not the bus (§13 OPEN-10): a session file leaving, and one arriving.
 * Everything else the browser does is a validated command on the socket; a downloadable artifact has no
 * representation there, so these calls talk to the store through the backend's export and import routes.
 */

/** Failure text the control bar shows as it stands — every branch here has one sentence for the user. */
export class SessionFileError extends Error {}

interface ImportCounts {
  transcripts: number;
  nodes: number;
  embedded: number;
  embeddingError?: string;
}

interface ExchangeRow {
  question: { id: string; text: string; createdAt: number; snapshotId: string };
  answer: {
    questionId: string;
    text: string;
    citations: Citation[];
    durationMs: number;
    degraded: boolean;
    createdAt: number;
  } | null;
}

export async function downloadSession(sessionId: string): Promise<string> {
  const response = await request(`${API_BASE}/api/session/${sessionId}/export`);
  if (response.status === 404) throw new SessionFileError("后端已经找不到这个会话了，它可能不在这台机器的数据库里。");
  if (!response.ok) throw new SessionFileError(`导出失败（HTTP ${response.status}）。`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `session-${sessionId}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking in the same turn cancels the save, so the click gets a tick to finish.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `已导出 ${Math.round(blob.size / 1024)} KB：session-${sessionId}.json`;
}

/**
 * Import a file and open what it produced. The backend gives the new session a fresh id, so importing
 * the same file twice leaves two histories instead of one overwriting the other.
 */
export async function importSessionFile(file: File): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new SessionFileError("这个文件不是合法的 JSON，读不出会话内容。");
  }
  const response = await request(`${API_BASE}/api/session/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(raw),
  });
  if (response.status === 409) throw new SessionFileError("正在录音。先结束当前录音，再导入历史会话。");
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as { issues?: string[] } | null;
    const issues = (body?.issues ?? []).slice(0, 6).map((issue) => `· ${issue}`);
    throw new SessionFileError(`这份文件不能导入：\n${issues.join("\n") || "· 后端没有给出原因"}`);
  }
  if (!response.ok) throw new SessionFileError(`导入失败（HTTP ${response.status}）。`);
  const body = (await response.json()) as { opened: boolean; counts: ImportCounts };
  if (!body.opened) throw new SessionFileError("会话已导入本机，但没能打开：服务端刚好开始了一段录音。");
  resyncFromServer();
  const index =
    body.counts.embedded < body.counts.transcripts
      ? `，检索索引只建好 ${body.counts.embedded}/${body.counts.transcripts} 条，久远的内容可能答不上（${
          body.counts.embeddingError ?? "向量数量不足"
        }）`
      : "";
  return `已打开历史会话：${body.counts.transcripts} 段原文、${body.counts.nodes} 个节点${index}`;
}

/**
 * The Q&A a session already recorded. Answers stream and are never replayed, so a tab that opens a
 * history has to read them out of the store instead — unanswered questions are skipped rather than
 * drawn as an empty bubble.
 */
export async function loadHistoryAnswers(sessionId: string): Promise<void> {
  const response = await request(`${API_BASE}/api/session/${sessionId}/questions`);
  if (!response.ok) return;
  const body = (await response.json()) as { exchanges: ExchangeRow[] };
  const answers: Answer[] = body.exchanges
    .filter((entry) => entry.answer !== null)
    .map((entry) => ({
      questionId: entry.question.id,
      question: entry.question.text,
      text: entry.answer?.text ?? "",
      done: true,
      degraded: entry.answer?.degraded ?? false,
      citations: entry.answer?.citations ?? [],
      durationMs: entry.answer?.durationMs,
    }));
  useSessionStore.getState().setHistoryAnswers(answers);
}

/** Fetch that turns "the backend is not there" into a sentence instead of a TypeError. */
async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new SessionFileError(
      `连不上本机后端（${API_BASE}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
