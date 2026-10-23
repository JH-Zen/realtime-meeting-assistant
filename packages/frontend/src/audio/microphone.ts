import { sendCaptureEnd, sendCommand } from "../net/connection";
import { useSessionStore } from "../state/sessionStore";
// Emit a real same-origin asset so AudioWorklet works under the desktop's script-src 'self' CSP.
// Explicit no-inline avoids Vite turning this small script into a data URL.
import WORKLET_URL from "./pcm16-processor.js?url&no-inline";

/**
 * Starts the microphone and uploads what it hears as `audio.chunk` commands.
 *
 * Nothing is buffered here: if the socket is down the chunk is dropped, because a tab that queues
 * audio through a reconnect would replay the same minutes of speech into a transcript that already
 * has them. The recogniser is the authority on what was said; a gap is a gap.
 */
export interface MicrophoneCapture {
  /** Release the microphone and stop the audio graph. */
  stop(): void;
}

const releases = new Set<() => void>();
let captureGeneration = 0;

/** Also invalidates permission/worklet promises that complete after the desktop requested exit. */
export function stopAllMicrophones(): void {
  captureGeneration += 1;
  for (const release of [...releases]) release();
}

export async function startMicrophone(): Promise<MicrophoneCapture> {
  const generation = captureGeneration;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (generation !== captureGeneration) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("应用已停止采集，已取消迟到的麦克风请求");
  }
  let context: AudioContext | null = null;
  // Everything below the permission can still fail — a worklet that will not compile, a processor
  // the engine refuses to build, a context the browser will not start — and a half-built graph holds
  // the device: the light stays on and no other application gets the microphone until the tracks
  // stop. `RecordingControls` only learns about the failure, so the release cannot be left to it.
  let released = false;
  const captureId = crypto.randomUUID();
  let boundSession: string | null = null;
  let originTime = 0;
  let samples = 0;
  let seq = 0;
  const release = () => {
    if (released) return;
    released = true;
    if (boundSession) sendCaptureEnd({ sessionId: boundSession, captureId, originTime, endTime: originTime + samples / 16000, nextSeq: seq });
    releases.delete(release);
    for (const track of stream.getTracks()) track.stop();
    if (context && context.state !== "closed") void context.close();
  };
  releases.add(release);
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule(WORKLET_URL);
    if (generation !== captureGeneration) throw new Error("应用已停止采集");
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "pcm16-16k", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
    });

    node.port.onmessage = (event: MessageEvent<Int16Array>) => {
      if (released) return;
      const state = useSessionStore.getState();
      // Permission/setup audio belongs to no recording. Bind only after backend acknowledgement.
      if (state.recording !== "recording" || !state.sessionId || (boundSession && boundSession !== state.sessionId)) return;
      if (!boundSession) { boundSession = state.sessionId; originTime = state.elapsedSec; }
      const startTime = originTime + samples / 16000;
      samples += event.data.length;
      sendCommand({ cmd: "audio.chunk", seq: seq++, pcmBase64: toBase64(event.data), capture: { sessionId: boundSession, captureId, originTime, startTime } });
    };
    source.connect(node);
    // A worklet whose output goes nowhere is never scheduled, so the node must reach the destination —
    // and it is safe to connect because the processor leaves its output buffer silent.
    node.connect(context.destination);
    if (context.state === "suspended") await context.resume();
    if (generation !== captureGeneration) throw new Error("应用已停止采集");

    return {
      stop() {
        node.port.onmessage = null;
        node.disconnect();
        source.disconnect();
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

function toBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  // 3200 bytes per 100 ms chunk: one pass, no chunked `fromCharCode` trick needed.
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
