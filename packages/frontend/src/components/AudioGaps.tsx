import { useEffect, useState } from "react";
import type { AudioGap } from "@rcc/shared";
import { API_BASE } from "../config";
import { apiFetch } from "../net/api";
import { useSessionStore } from "../state/sessionStore";
import { formatClock } from "../format";

export function AudioGaps() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const link = useSessionStore((s) => s.link);
  const [value, setValue] = useState<{ sessionId: string; gaps: AudioGap[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    setValue(null); setFailure(null);
    if (!sessionId || link !== "open") return;
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await apiFetch(`${API_BASE}/api/session/${encodeURIComponent(sessionId)}/audio-gaps`, { signal: controller.signal });
        if (!response.ok) throw new Error(`缺口记录读取失败（${response.status}）`);
        const next = await response.json() as { sessionId: string; gaps: AudioGap[] };
        if (active && next.sessionId === sessionId) { setValue(next); setFailure(null); }
      } catch (error) { if (active) setFailure(String(error)); }
      finally { if (active) timer = setTimeout(load, 1000); }
    };
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId, link]);
  if (!sessionId) return null;
  const gaps = value?.sessionId === sessionId ? value.gaps : [];
  return <section className="audio-gaps" aria-label="音频缺口记录">
    <details>
      <summary>音频缺口记录 · {value ? `${gaps.length} 个区间` : "等待连接"}</summary>
      {failure && <p role="status">{failure}</p>}
      <p>这里只记录可观测的丢失或不确定区间，不能补回音频；没有记录也不代表录音完整。区间可能重叠。</p>
      <ul>{gaps.slice(-50).map((gap) => <li key={gap.id}>
        {formatClock(gap.startTime)}–{formatClock(gap.endTime)}（{(gap.endTime - gap.startTime).toFixed(2)} 秒） · {gap.stage === "capture_backend" ? "采集到后台" : "后台到识别"} · {gap.certainty === "observed" ? "观察到链路缺口" : "可能丢失，未确认"}
      </li>)}</ul>
      {gaps.length > 50 && <p>显示最近 50 个区间；完整记录包含在会话导出文件中。</p>}
    </details>
  </section>;
}
