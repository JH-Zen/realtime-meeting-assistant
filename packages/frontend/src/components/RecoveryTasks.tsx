import { useEffect, useState } from "react";
import { RecoveryTaskSchema, type RecoveryTask } from "@rcc/shared";
import { API_BASE } from "../config";
import { apiFetch } from "../net/api";
import { useSessionStore } from "../state/sessionStore";

const statusText = { running: "进行中", succeeded: "本次补建已完成", incomplete: "达到批次上限，仍待补建", failed: "本次补建未完成", interrupted: "任务已中断" };
const liveStatusText = { running: "实时处理中", succeeded: "本批已确认处理", incomplete: "部分处理，仍待补建", failed: "本批处理失败", interrupted: "实时任务已中断" };
const attemptText = { running: "进行中", succeeded: "已保存", incomplete: "部分保存", failed: "未完成", interrupted: "已中断" };
const reasonText = { batch_failed: "批次处理失败", incomplete_output: "返回内容不完整", cancelled: "切换会议或退出时中断", process_interrupted: "上次后台退出前未完成", audit_failed: "任务记录保存失败", backlog_full: "积压已满，本段未进入索引", invalid_output: "模型返回内容无效", partial_graph: "部分导图操作未应用，补建可能调整已有节点" };

/** Reads durable operational history; opening the panel never starts a repair or model request. */
export function RecoveryTasks() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const recording = useSessionStore((s) => s.recording);
  const link = useSessionStore((s) => s.link);
  const [scope, setScope] = useState<"manual" | "live" | "all">("manual");
  const [result, setResult] = useState<{ sessionId: string; scope: string; tasks: RecoveryTask[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const available = sessionId !== null && recording !== "idle";
  const viewing = recording === "viewing";
  useEffect(() => { setScope(sessionId !== null && viewing ? "manual" : "live"); }, [sessionId, viewing]);

  useEffect(() => {
    setResult(null); setFailure(null);
    if (!available || link !== "open") return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await apiFetch(`${API_BASE}/api/session/${encodeURIComponent(sessionId)}/recovery-tasks?scope=${scope}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`补建任务记录读取失败（${response.status}），历史尝试状态未知。`);
        const value = await response.json() as { sessionId: string; tasks: unknown };
        const tasks = RecoveryTaskSchema.array().max(10).parse(value.tasks);
        if (value.sessionId !== sessionId || tasks.some((task) => task.sessionId !== sessionId)) throw new Error("任务记录的会议归属不匹配。");
        if (active) { setResult({ sessionId, scope, tasks }); setFailure(null); }
      } catch (error) {
        if (active) { setResult(null); setFailure(error instanceof Error ? error.message : "任务记录读取失败。"); }
      } finally { if (active) timer = setTimeout(load, 2000); }
    };
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId, available, link, scope]);

  if (!available) return null;
  const tasks = result?.sessionId === sessionId && result.scope === scope ? result.tasks : null;
  return (
    <section className="recovery-tasks" aria-label="处理任务记录">
      <details>
        <summary>处理任务记录{tasks ? ` · ${tasks.length} 次` : ""}</summary>
        <label>查看范围 <select aria-label="任务记录范围" value={scope} onChange={(event) => setScope(event.target.value as "manual" | "live" | "all")}><option value="manual">手动补建</option><option value="live">实时处理</option><option value="all">全部</option></select></label>
        <p>显示所选范围最近10次本机任务。次数不等于底层请求次数，确认处理不代表内容准确；旧版来源不补造，摘要/问答尚无此记录，记录不随会话文件导出。</p>
        {link !== "open" ? <p role="status">连接恢复后可读取任务记录。</p>
          : failure ? <p role="status">{failure}</p>
          : !tasks ? <p>正在读取任务记录…</p>
          : tasks.length === 0 ? <p>所选范围尚无本机任务记录；不能据此判断以前的处理是否成功。</p>
          : <ul>{tasks.map((task) => <li key={task.id}>
            <details>
              <summary>{task.kind === "retrieval" ? "检索索引" : "导图"} · {task.trigger === "live" ? liveStatusText[task.status] : statusText[task.status]} · {task.attempts.length} 次批次尝试</summary>
              <p>{new Date(task.startedAt).toLocaleString()} · {task.trigger === "live" ? "本批输入" : "初始缺失"} {task.initialMissing} 段 · 完成 {task.completedBatches} 批 · {task.trigger === "live" ? "本批未确认" : "结束时缺失"} {task.remaining ?? "未知"} 段{task.failureCode ? ` · ${reasonText[task.failureCode]}` : ""}</p>
              <p>来源：{task.trigger === "live" ? "实时处理" : task.trigger === "manual" ? "手动补建" : "未标注（旧格式）"}{task.sourceSegmentIds ? ` · 已记录 ${task.sourceSegmentIds.length} 个原文段标识` : ""}</p>
              <ol>{task.attempts.map((attempt) => <li key={`${attempt.batch}:${attempt.attempt}`}>第 {attempt.batch} 批，第 {attempt.attempt} 次：{attemptText[attempt.outcome]} · 输入 {attempt.inputCount} 段，确认保存 {attempt.savedCount} 段</li>)}</ol>
            </details>
          </li>)}</ul>}
      </details>
    </section>
  );
}
