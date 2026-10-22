import { sendCommand } from "../net/connection";
// Loaded as text rather than as a URL: Vite inlines a file this small as a `data:` URL, and
// `addModule` handling of those varies by browser. A blob URL is the form every engine accepts.
import WORKLET_SOURCE from "./pcm16-processor.js?raw";

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

export async function startMicrophone(): Promise<MicrophoneCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext();
  // Everything below the permission can still fail — a worklet that will not compile, a processor
  // the engine refuses to build, a context the browser will not start — and a half-built graph holds
  // the device: the light stays on and no other application gets the microphone until the tracks
  // stop. `RecordingControls` only learns about the failure, so the release cannot be left to it.
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    if (context.state !== "closed") void context.close();
  };
  try {
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      // Revoking once the module is compiled leaves no blob behind for a tab that never records.
      URL.revokeObjectURL(workletUrl);
    }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "pcm16-16k", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
    });

    let seq = 0;
    node.port.onmessage = (event: MessageEvent<Int16Array>) => {
      sendCommand({ cmd: "audio.chunk", seq: seq++, pcmBase64: toBase64(event.data) });
    };
    source.connect(node);
    // A worklet whose output goes nowhere is never scheduled, so the node must reach the destination —
    // and it is safe to connect because the processor leaves its output buffer silent.
    node.connect(context.destination);
    if (context.state === "suspended") await context.resume();

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
