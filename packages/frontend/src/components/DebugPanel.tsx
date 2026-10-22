import { useEffect, useState } from "react";
import { useGraphStore } from "../state/graphStore";
import { useSessionStore } from "../state/sessionStore";
import { API_BASE } from "../config";

interface DebugSnapshot {
  bus: { events: Record<string, number> };
  recording: { state: string; elapsedSec: number };
  mindmap: { pending: number; busy: boolean; nodeCount: number };
  retrieval: { pending: number; indexed: number; dropped: number };
  loopDelay: { p50Ms: number; p95Ms: number; maxMs: number };
  recentOperations: { opId: string; type: string }[];
}

/** §48: queue depth and counters that are diagnostics, not part of the UI contract. */
export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const droppedFrames = useSessionStore((s) => s.droppedFrames);
  const errors = useSessionStore((s) => s.errors);
  const clearErrors = useSessionStore((s) => s.clearErrors);
  const staleOpIds = useGraphStore((s) => s.staleOpIds);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/debug`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (alive) {
          setSnapshot((await response.json()) as DebugSnapshot);
          setFailure(null);
        }
      } catch (error) {
        if (alive) setFailure(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open]);

  return (
    <footer className="debug">
      <button type="button" onClick={() => setOpen((value) => !value)}>{open ? "收起调试面板" : "调试面板"}</button>
      {!open && <span className="debug__inline">错误 {errors.length} · 丢弃帧 {droppedFrames}</span>}
      {open && (
        <div className="debug__grid">
          <section>
            <h3>Event Bus</h3>
            <ul>
              {Object.entries(snapshot?.bus.events ?? {}).map(([name, count]) => (
                <li key={name}>
                  <code>{name}</code> {count}
                </li>
              ))}
              {snapshot === null && <li className="empty">{failure ?? "无数据"}</li>}
            </ul>
          </section>
          <section>
            <h3>MindMap 队列</h3>
            <ul>
              <li>缓冲片段 {snapshot?.mindmap.pending ?? 0}</li>
              <li>单飞占用 {String(snapshot?.mindmap.busy ?? false)}</li>
              <li>服务端节点 {snapshot?.mindmap.nodeCount ?? 0} / 本地 {staleOpIds.length ? "待补齐" : "一致"}</li>
              <li>丢弃帧 {droppedFrames}</li>
            </ul>
          </section>
          <section>
            <h3>主循环延迟 / 检索</h3>
            <ul>
              <li>p50 {snapshot?.loopDelay.p50Ms ?? 0} ms · p95 {snapshot?.loopDelay.p95Ms ?? 0} ms · 峰值 {snapshot?.loopDelay.maxMs ?? 0} ms</li>
              <li>检索待嵌 {snapshot?.retrieval.pending ?? 0} · 已入库 {snapshot?.retrieval.indexed ?? 0} · 丢弃 {snapshot?.retrieval.dropped ?? 0}</li>
            </ul>
          </section>
          <section>
            <h3>最近操作</h3>
            <ul>
              {(snapshot?.recentOperations ?? []).map((op) => (
                <li key={op.opId}>
                  <code>{op.type}</code> {op.opId}
                </li>
              ))}
              {(snapshot?.recentOperations.length ?? 0) === 0 && <li className="empty">暂无</li>}
            </ul>
          </section>
          <section>
            <h3>模块错误</h3>
            <ul>
              {errors.map((error) => (
                <li key={`${error.module}-${error.at}`}>
                  <code>{error.module}</code> {error.code}: {error.message}
                </li>
              ))}
              {errors.length === 0 && <li className="empty">暂无</li>}
            </ul>
            {errors.length > 0 && <button type="button" onClick={clearErrors}>清除</button>}
          </section>
        </div>
      )}
    </footer>
  );
}
