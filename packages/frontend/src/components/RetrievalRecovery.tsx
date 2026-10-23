import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../config";
import { apiFetch } from "../net/api";
import { useSessionStore } from "../state/sessionStore";

interface IndexStatus {
  sessionId: string;
  provider: string;
  total: number;
  indexed?: number;
  processed?: number;
  legacyUntracked?: boolean;
  missing: number;
  busy: boolean;
  lastError: string | null;
  completedBatches: number;
}

/** A small real-data repair entry for review mode; recording and audio gaps are separate work. */
export function RetrievalRecovery({ mode = "retrieval" }: { mode?: "retrieval" | "mindmap" }) {
  const mindmap = mode === "mindmap";
  const label = mindmap ? "导图处理" : "检索索引";
  const sessionId = useSessionStore((s) => s.sessionId);
  const recording = useSessionStore((s) => s.recording);
  const link = useSessionStore((s) => s.link);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const sequence = useRef(0);
  const applied = useRef(0);
  const postController = useRef<AbortController | null>(null);
  const viewing = recording === "viewing" && sessionId !== null;

  useEffect(() => {
    setStatus(null);
    setFailure(null);
    setSubmitting(null);
    applied.current = ++sequence.current;
    if (!viewing || link !== "open") return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const order = ++sequence.current;
      try {
        const response = await apiFetch(`${API_BASE}/api/session/${encodeURIComponent(sessionId)}/${mindmap ? "mindmap/recovery" : "retrieval"}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`${label}状态读取失败（${response.status}）`);
        const value = await response.json() as IndexStatus;
        if (active && order >= applied.current && value.sessionId === sessionId) {
          applied.current = order; setStatus(value); setFailure(null);
        }
      } catch (error) {
        if (active && order >= applied.current) { applied.current = order; setFailure(error instanceof Error ? error.message : String(error)); }
      } finally {
        if (active) timer = setTimeout(load, 2000);
      }
    };
    void load();
    return () => {
      active = false; controller.abort(); postController.current?.abort();
      postController.current = null; applied.current = ++sequence.current; clearTimeout(timer);
    };
  }, [sessionId, viewing, link, mindmap, label]);

  async function rebuild() {
    if (!sessionId || submitting === sessionId || !viewing || link !== "open") return;
    const requestedId = sessionId;
    const order = ++sequence.current;
    const controller = new AbortController();
    postController.current?.abort();
    postController.current = controller;
    setSubmitting(requestedId);
    setFailure(null);
    try {
      const response = await apiFetch(`${API_BASE}/api/session/${encodeURIComponent(requestedId)}/${mindmap ? "mindmap" : "retrieval"}/rebuild`, {
        method: "POST", signal: controller.signal,
        ...(mindmap && status?.legacyUntracked ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ allowUntracked: true }) } : {}),
      });
      const result = await response.json() as { status?: IndexStatus; message?: string };
      // A response to an old session cannot overwrite the newly selected session's status.
      if (controller.signal.aborted || order < applied.current || useSessionStore.getState().sessionId !== requestedId || useSessionStore.getState().recording !== "viewing") return;
      applied.current = order;
      if (!response.ok) throw new Error(result.message ?? `补建未开始（${response.status}）`);
      if (result.status?.sessionId === requestedId) setStatus(result.status);
    } catch (error) {
      if (!controller.signal.aborted && order >= applied.current && useSessionStore.getState().sessionId === requestedId && useSessionStore.getState().recording === "viewing") {
        applied.current = order;
        setFailure(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (postController.current === controller) {
        postController.current = null;
        setSubmitting((current) => current === requestedId ? null : current);
      }
    }
  }

  if (!viewing) return null;
  const current = status?.sessionId === sessionId ? status : null;
  const busy = current?.busy || submitting === sessionId;
  return (
    <section className="retrieval-recovery" aria-label={mindmap ? "导图补建" : "检索索引补建"}>
      <span>{current ? `${label} ${mindmap ? current.processed : current.indexed}/${current.total} · ${mindmap ? "未确认处理" : "缺失"} ${current.missing} 段` : `正在读取${label}状态…`}</span>
      <button type="button" disabled={!current || current.missing === 0 || busy || link !== "open"} onClick={() => void rebuild()}>
        {busy ? `正在补建${mindmap ? "导图" : "索引"}…` : mindmap ? current?.legacyUntracked ? "确认可能重复并补建导图" : "补建未处理导图" : "补建缺失索引"}
      </button>
      <span className="retrieval-recovery__detail">{mindmap ? "每次最多 8 批；处理完成不代表内容准确或全部成为节点。补建会调用当前问答模型。" : "每次最多 8 批；只补检索索引，原文保持不变。"}</span>
      {mindmap && current?.legacyUntracked && <span role="status">旧版或导入导图没有处理记录，部分失败也可能留下节点；无法确认相关原文已完整处理。再次补建可能重复或调整节点，仅在接受这一点时启动。</span>}
      {(failure || current?.lastError) && <span role="status">{failure ?? `补建未完成：${current?.lastError}。恢复服务后可再次补建。`}</span>}
      {link !== "open" && <span role="status">连接恢复后可查看与补建{mindmap ? "导图" : "索引"}。</span>}
    </section>
  );
}
