import WebSocket from "ws";
import type { BackendConfig } from "../config/env.js";
import type { SttConnection } from "@rcc/shared";

export interface SttReadiness { ready: boolean; message: string; model?: string; }

export function recordingSttReadiness(config: Pick<BackendConfig, "mockStt" | "stt">, current: { sttEngine: string | null; sttStatus: SttConnection } | null): Promise<SttReadiness> {
  if (config.mockStt) return Promise.resolve({ ready: false, message: "当前为模拟语音模式，请使用「模拟讲解」。真实麦克风需要配置 MOCK_STT=false 并启动 STT worker。" });
  // The Python worker accepts one recording connection. Resume must inspect the connection we already
  // own, rather than occupy a second slot and turn a healthy paused recording into a false failure.
  if (current) return Promise.resolve(current.sttEngine === "sherpa-onnx" && current.sttStatus === "connected"
    ? { ready: true, message: "本次录音的真实 STT 通道仍已连接，可以继续采集。" }
    : { ready: false, message: "本次录音的 STT 通道尚未连接；重连完成后再继续，若已失败请结束后重新开始。" });
  return probeSttWorker(config.stt);
}

/** Only validates the worker's announced protocol. No audio, model requests or recognition are performed. */
export function probeSttWorker(config: BackendConfig["stt"], timeoutMs = 2500): Promise<SttReadiness> {
  return new Promise((done) => {
    const socket = new WebSocket(config.wsUrl, { maxPayload: 64 * 1024 });
    let settled = false;
    const finish = (result: SttReadiness) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.CLOSED) { done(result); return; }
      // Return only after our probe has released the worker's single-client slot. A bounded fallback
      // terminates this probe socket only; it never owns or stops the user's worker process.
      const closeDeadline = setTimeout(() => { socket.terminate(); done(result); }, 500);
      socket.once("close", () => { clearTimeout(closeDeadline); done(result); });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close();
    };
    const timer = setTimeout(() => finish({ ready: false, message: "STT worker 未及时就绪；请先启动真实识别服务。" }), timeoutMs);
    socket.on("error", () => finish({ ready: false, message: `无法连接本地 STT worker（${config.wsUrl}）；请先启动 Python 识别服务。` }));
    socket.on("close", () => finish({ ready: false, message: "STT worker 在就绪前关闭了连接。" }));
    socket.on("message", (raw) => {
      if (settled) return;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString()); } catch { finish({ ready: false, message: "STT worker 返回了无法读取的就绪信息。" }); return; }
      if (frame?.type === "error" && frame.code === "busy") {
        finish({ ready: false, message: "STT worker 正被另一个识别连接使用；请先结束该连接，本应用不会接管它。" });
      } else if (frame?.type !== "ready" || frame.protocol !== 1 || typeof frame.model !== "string") {
        finish({ ready: false, message: "STT worker 协议不匹配，需要 protocol=1 的 ready 信息。" });
      } else if (frame.sampleRate !== config.sampleRate) {
        finish({ ready: false, message: `STT worker 采样率不匹配，需要 ${config.sampleRate} Hz。` });
      } else finish({ ready: true, model: frame.model, message: "真实 STT 通道已就绪；识别效果仍需实际语音验证。" });
    });
  });
}
