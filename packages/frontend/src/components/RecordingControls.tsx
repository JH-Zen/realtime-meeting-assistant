import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../state/sessionStore";
import { useGraphStore } from "../state/graphStore";
import { sendCommand } from "../net/connection";
import { SessionHistory } from "./SessionHistory";
import { downloadSession, importSessionFile } from "../net/sessionFile";
import { formatClock, linkLabel } from "../format";
import { startMicrophone, stopAllMicrophones, type MicrophoneCapture } from "../audio/microphone";
import { API_BASE } from "../config";
import { apiFetch } from "../net/api";

/**
 * The server reports elapsed time in events, which only arrive at lifecycle boundaries. Between
 * them the clock is advanced locally so a running recording does not look frozen.
 */
function useElapsedClock(baselineSec: number, running: boolean): number {
  const [extraSec, setExtraSec] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `baselineSec` is the re-anchor trigger, not a value the body reads
  useEffect(() => {
    if (!running) {
      setExtraSec(0);
      return;
    }
    // Re-anchor whenever a fresh server value lands, so the local count can never drift away from it.
    const started = Date.now();
    setExtraSec(0);
    const timer = setInterval(() => setExtraSec((Date.now() - started) / 1000), 1000);
    return () => clearInterval(timer);
  }, [running, baselineSec]);
  return running ? baselineSec + extraSec : baselineSec;
}

export function RecordingControls() {
  const recording = useSessionStore((s) => s.recording);
  const elapsedSec = useSessionStore((s) => s.elapsedSec);
  const link = useSessionStore((s) => s.link);
  const reconnectAttempts = useSessionStore((s) => s.reconnectAttempts);
  const stt = useSessionStore((s) => s.stt);
  const sessionId = useSessionStore((s) => s.sessionId);
  const commandFailure = useSessionStore((s) => s.errors.findLast((error) => error.code === "command_failed"));
  const nodeCount = useGraphStore((s) => Object.keys(s.graph.nodes).length);

  const offline = link !== "open";
  const shownSec = useElapsedClock(elapsedSec, recording === "recording");

  /** Which input the running recording came from, so 继续 resumes the same one. */
  const source = useRef<"mic" | "mock">("mock");
  const capture = useRef<MicrophoneCapture | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  /**
   * Set when a 暂停 or 结束 released the device but the command never reached the server. The badge
   * keeps saying 录音 recording in that window, and a page that captures nothing while promising
   * speech has to say so — otherwise the gap is only noticed when reading the transcript later.
   */
  const [detached, setDetached] = useState(false);
  /** One line about the session file that just left or arrived, kept apart from the recording notices. */
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const actionGeneration = useRef(0);
  const pendingAction = useRef(false);
  const requestAbort = useRef<AbortController | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [ending, setEnding] = useState(false);
  const [modes, setModes] = useState<{ stt: string; llm: string; embedding: string; embeddingReady: boolean } | null>(null);

  // A tab that unmounts while the microphone is open would leave the device indicator on.
  useEffect(() => () => {
    ++actionGeneration.current;
    requestAbort.current?.abort();
    capture.current?.stop();
    stopAllMicrophones();
  }, []);

  useEffect(() => {
    if (recording !== "idle") { pendingAction.current = false; setPreparing(false); }
    if (recording === "idle" || recording === "viewing") {
      setEnding(false);
      capture.current?.stop();
      capture.current = null;
      stopAllMicrophones();
    }
  }, [recording]);

  useEffect(() => { if (commandFailure || link !== "open") setEnding(false); }, [commandFailure, link]);

  // Notices belong to the selected meeting; a newly opened history must not inherit old failures.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected id is the reset trigger
  useEffect(() => { setMicError(null); setFileNotice(null); }, [sessionId]);

  useEffect(() => {
    if (link !== "open") return;
    let current = true;
    void apiFetch(`${API_BASE}/api/modes`).then(async (response) => {
      if (response.ok) { const value = await response.json(); if (current) setModes(value); }
    }).catch(() => undefined);
    return () => { current = false; };
  }, [link]);

  useEffect(() => {
    if (stt.state !== "failed" && (link === "open" || !pendingAction.current)) return;
    ++actionGeneration.current;
    pendingAction.current = false;
    setPreparing(false);
    requestAbort.current?.abort();
    capture.current?.stop();
    capture.current = null;
    stopAllMicrophones();
    window.rccDesktop?.setCaptureActive(false);
  }, [link, stt.state]);

  // Whatever the server last told us wins: once it no longer says the session is running, the
  // divergence this flag describes is gone.
  useEffect(() => {
    if (recording !== "recording") setDetached(false);
  }, [recording]);

  function closeMicrophone(): void {
    ++actionGeneration.current;
    pendingAction.current = false;
    setPreparing(false);
    requestAbort.current?.abort();
    capture.current?.stop();
    capture.current = null;
    stopAllMicrophones();
    window.rccDesktop?.setCaptureActive(false);
  }

  async function startInput(kind: "mic" | "mock", resume = false) {
    if (pendingAction.current) return;
    pendingAction.current = true;
    setPreparing(true);
    const generation = ++actionGeneration.current;
    const controller = new AbortController();
    requestAbort.current = controller;
    window.rccDesktop?.setCaptureActive(true);
    setMicError(null);
    setDetached(false);
    try {
      if (kind === "mic") {
        // No permission/device request until the configured recognition channel has announced ready.
        const response = await apiFetch(`${API_BASE}/api/recording/preflight?source=mic`, { signal: controller.signal });
        if (!response.ok) throw new Error(`语音准备检查失败（HTTP ${response.status}）`);
        const readiness = await response.json() as { ready: boolean; message: string };
        if (!readiness.ready) throw new Error(readiness.message);
        if (generation !== actionGeneration.current) return;
        const opened = await startMicrophone();
        if (generation !== actionGeneration.current) { opened.stop(); return; }
        capture.current = opened;
      }
      if (generation !== actionGeneration.current) return;
      source.current = kind;
      if (!sendCommand(resume ? { cmd: "recording.resume" } : { cmd: "recording.start", source: kind })) throw new Error("后台连接已断开，未开始采集。");
      // Keep the action locked until the server acknowledges recording.started/resumed.
    } catch (error) {
      if (generation !== actionGeneration.current) return;
      closeMicrophone();
      setMicError(`${kind === "mic" ? "麦克风" : "输入"}不可用：${error instanceof Error ? error.message : String(error)}`);
      window.rccDesktop?.setCaptureActive(false);
    }
  }

  async function begin(kind: "mic" | "mock") { await startInput(kind); }
  async function resume() { await startInput(source.current, true); }

  function pause() {
    // Pausing releases the microphone: a user who pressed 暂停 expects the device to go quiet.
    closeMicrophone();
    setDetached(!sendCommand({ cmd: "recording.pause" }));
  }

  function stop() {
    const cancelPreparation = preparing;
    closeMicrophone();
    if (cancelPreparation) return;
    const sent = sendCommand({ cmd: recording === "viewing" ? "session.close" : "recording.stop" });
    setEnding(sent);
    setDetached(!sent);
  }

  /**
   * Export and import are the two actions that go to the store rather than to the bus, and both are
   * reported here in one line: the file is the artifact the user keeps, so "what happened to my click"
   * has to be visible even when the recording state never changed.
   */
  async function runSessionFile(action: () => Promise<string>): Promise<void> {
    setFileNotice(null);
    try {
      setFileNotice(await action());
    } catch (error) {
      setFileNotice(error instanceof Error ? error.message : String(error));
    }
  }

  // Reconnecting is worth a line of its own: subtitles have stopped but the microphone is still
  // running, and a silent gap in the transcript is otherwise only noticed when reading it later.
  const notice =
    fileNotice ??
    micError ??
    (detached
      ? "本页已停止采集，但这条命令没能送达服务端，画面上的录音状态还没跟上。重连后再按一次即可对齐。"
      : stt.state === "failed" || stt.state === "reconnecting"
        ? (stt.message ?? "识别引擎未连接")
        : null);

  return (
    <header className="controls">
      <div className="controls__buttons">
        <button
          type="button"
          className="primary"
          disabled={offline || preparing || ending || (recording !== "idle" && recording !== "viewing")}
          onClick={() => void begin("mic")}
        >
          麦克风录音
        </button>
        <button
          type="button"
          disabled={offline || preparing || ending || (recording !== "idle" && recording !== "viewing")}
          onClick={() => void begin("mock")}
        >
          模拟讲解
        </button>
        {/* 暂停 and 结束 release the microphone locally, so they must stay clickable when the socket
            is down — `sendCommand` drops the command on its own. The device indicator would otherwise
            keep burning until reconnect, and only the server can end the session. */}
        <button type="button" disabled={ending || recording !== "recording"} onClick={pause}>
          暂停
        </button>
        <button type="button" disabled={offline || preparing || ending || recording !== "paused"} onClick={() => void resume()}>
          继续
        </button>
        <button type="button" disabled={ending || (recording === "idle" && !preparing)} onClick={stop}>
          {preparing ? "取消准备" : ending ? "正在收尾…" : recording === "viewing" ? "关闭会议" : "结束"}
        </button>
        <button type="button" disabled={offline || ending || recording === "viewing" || recording === "idle"} onClick={() => sendCommand({ cmd: "mindmap.forceUpdate" })}>
          立即整理导图
        </button>
        {/* Both talk to the store, not the recogniser, so neither waits for the socket: exporting the
            session you are recording is how a crash-proof copy gets made mid-talk. */}
        <button
          type="button"
          disabled={!sessionId}
          onClick={() => {
            if (!sessionId) return;
            void runSessionFile(() => downloadSession(sessionId));
          }}
        >
          导出会话
        </button>
        <button
          type="button"
          disabled={offline || preparing || ending || recording === "recording" || recording === "paused"}
          onClick={() => fileInput.current?.click()}
        >
          导入历史会话
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so picking the same file twice still fires, and so the box never shows a stale name.
            event.target.value = "";
            if (file) void runSessionFile(() => importSessionFile(file));
          }}
        />
      </div>

      <div className="controls__status">
        {modes && <span className="badge">语音配置 {modes.stt === "mock" ? "模拟" : "真实"} · 问答 {/mock/i.test(modes.llm) ? "模拟" : "真实"} · 检索 {/mock/i.test(modes.embedding) ? "模拟" : modes.embeddingReady ? "真实" : "真实（缺运行时/模型）"}</span>}
        {preparing && <span className="badge">正在准备输入，可取消</span>}
        <Badge
          label="连接"
          value={linkLabel(link, reconnectAttempts)}
          tone={link === "open" ? "ok" : reconnectAttempts > 2 ? "bad" : "warn"}
        />
        <Badge
          label="识别"
          value={stt.state}
          tone={stt.state === "failed" ? "bad" : stt.state === "connected" ? "ok" : "warn"}
          title={stt.message ?? undefined}
        />
        <Badge
          label="录音"
          value={recording === "viewing" ? "已停止采集 · 可继续提问" : recording}
          tone={recording === "recording" ? "ok" : "idle"}
        />
        <Badge label="时长" value={formatClock(shownSec)} tone="idle" />
        <Badge label="节点" value={String(nodeCount)} tone="idle" />
      </div>

      {/* `pre-line` because an import refusal lists the reasons, and a one-line clamped paragraph would
          show only the first. */}
      {notice && (
        <p className="controls__notice" style={{ whiteSpace: "pre-line" }}>
          {notice}
        </p>
      )}
      <SessionHistory busy={preparing || ending} />
    </header>
  );
}

function Badge({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "bad" | "idle";
  title?: string;
}) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      <em>{label}</em>
      {value}
    </span>
  );
}
