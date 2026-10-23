import { useEffect, useRef, useState } from "react";
import { SessionListEntrySchema, type SessionListEntry } from "@rcc/shared";
import { API_BASE } from "../config";
import { apiFetch } from "../net/api";
import { formatClock } from "../format";
import { useSessionStore } from "../state/sessionStore";

const PAGE_SIZE = 20;
const dateLabel = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });

/** A small view over the actual local store. Selecting history never attaches an input source. */
export function SessionHistory({ busy }: { busy: boolean }) {
  const link = useSessionStore((s) => s.link);
  const sessionId = useSessionStore((s) => s.sessionId);
  const session = useSessionStore((s) => s.session);
  const recording = useSessionStore((s) => s.recording);
  const [rows, setRows] = useState<SessionListEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const disabled = busy || opening || link !== "open" || recording === "recording" || recording === "paused";

  // All changing inputs are explicit; reload's request guard also covers a manual refresh racing
  // with pagination or a session switch. Unmount and link loss abort the old result.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload always uses offset 0 here
  useEffect(() => {
    if (link === "open") void reload(0);
    return () => { ++requestVersion.current; abort.current?.abort(); };
  }, [link, sessionId, recording]);

  async function reload(offset: number): Promise<void> {
    const version = ++requestVersion.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`${API_BASE}/api/sessions?limit=${PAGE_SIZE}&offset=${offset}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`读取本机会议失败（HTTP ${response.status}）。`);
      const body = await response.json() as { sessions: unknown[]; hasMore: boolean };
      const parsed = body.sessions.map((entry) => SessionListEntrySchema.parse(entry));
      if (version !== requestVersion.current) return;
      setRows((previous) => offset === 0 ? parsed : [...previous, ...parsed]);
      setHasMore(body.hasMore);
    } catch (cause) {
      if (version === requestVersion.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  async function open(id: string): Promise<void> {
    setOpening(true);
    setError(null);
    try {
      const response = await apiFetch(`${API_BASE}/api/session/${encodeURIComponent(id)}/open`, { method: "POST" });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? `打开会议失败（HTTP ${response.status}）。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setOpening(false); }
  }

  return (
    <div className="session-history">
      {recording === "viewing" && session && (
        <p className="session-history__current">
          当前：{session.title ?? `会议 ${dateLabel(session.startedAt)}`} · {session.id.slice(0, 8)}
          {session.status !== "completed" && <span className="notice">上次录音未正常结束；仅查看已保存内容，不会自动继续采集。</span>}
        </p>
      )}
      <details>
        <summary>本机会议</summary>
        <div className="session-history__tools">
          <span>打开已保存的原文、导图和问答；录音时请先结束并等待收尾。</span>
          <button type="button" disabled={loading || link !== "open"} onClick={() => void reload(0)}>刷新列表</button>
        </div>
        {error && <p className="notice" role="status">{error}</p>}
        {rows.length === 0 && !loading && <p className="empty">本机还没有保存的会议。可以开始录音或导入会话文件。</p>}
        <ul className="session-history__list" aria-label="已保存的本机会议">
          {rows.map((row) => (
            <li key={row.id} data-session-id={row.id}>
              <div>
                <strong>{row.title ?? `会议 ${dateLabel(row.startedAt)}`}</strong>
                <span>{row.id.slice(0, 8)} · {row.transcriptCount} 段原文 · {row.nodeCount} 个节点 · {row.durationSec === undefined ? "旧记录未保存采集时长" : formatClock(row.durationSec)} · {row.status === "completed" ? "已结束" : row.id === sessionId && recording !== "viewing" ? "录音中" : "未正常结束"}</span>
              </div>
              <button type="button" aria-current={row.id === sessionId ? "true" : undefined} disabled={disabled || row.id === sessionId} onClick={() => void open(row.id)}>{row.id === sessionId ? "当前会议" : "打开"}</button>
            </li>
          ))}
        </ul>
        {loading && <p className="empty" role="status">正在读取本机会议…</p>}
        {hasMore && <button type="button" disabled={loading || link !== "open"} onClick={() => void reload(rows.length)}>载入更多</button>}
      </details>
    </div>
  );
}
