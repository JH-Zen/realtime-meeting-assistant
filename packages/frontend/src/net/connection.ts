import { decodeServerEvent, type AudioCaptureEnd, type ClientCommand } from "@rcc/shared";
import { useSessionStore } from "../state/sessionStore";
import { dispatchEvent } from "./dispatch";

/**
 * A browser tab is another subscriber to the backend bus. Reconnects back off — 1s doubling to an 8s
 * ceiling, and never giving up, because a tab has no better answer than trying again — and every fresh
 * socket is answered with the snapshots it needs: session state, the graph including the positions the
 * user dragged, finals, and saved Q&A. A reconnect restores answers completed while disconnected;
 * interrupted questions remain visible without an endless pending indicator.
 */
const MAX_BACKOFF_MS = 8000;

let socket: WebSocket | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wanted = false;
let target = "";
let authorize: (() => Promise<void>) | undefined;
let dialGeneration = 0;
// Control metadata only, never PCM. A stopped capture can disclose its lost tail on reconnect.
const pendingCaptureEnds = new Map<string, AudioCaptureEnd>();

export function sendCaptureEnd(capture: AudioCaptureEnd): void {
  if (sendCommand({ cmd: "audio.capture.end", capture })) return;
  pendingCaptureEnds.set(capture.captureId, capture);
  if (pendingCaptureEnds.size > 32) { const first = pendingCaptureEnds.keys().next().value; if (first) pendingCaptureEnds.delete(first); }
}

export function connect(url: string, prepare?: () => Promise<void>): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  attempt = 0;
  closeQuietly();
  wanted = true;
  target = url;
  authorize = prepare;
  open();
}

export function disconnect(): void {
  wanted = false;
  dialGeneration += 1;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  closeQuietly();
}

/**
 * Drop the current socket without letting its `close` event start a retry, so the caller decides when
 * the next connection happens. Used by `disconnect` and by a session switch that needs fresh snapshots.
 */
function closeQuietly(): void {
  const ws = socket;
  socket = null;
  if (!ws) return;
  // Silence it first: a StrictMode remount otherwise leaves a handler that still writes to stores.
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  // Closing a socket that is still handshaking is what the browser warns about; wait for open.
  if (ws.readyState === WebSocket.CONNECTING) ws.addEventListener("open", () => ws.close());
  else ws.close();
}

/**
 * Reconnect to make the server re-send its snapshots. Opening an imported session changes everything
 * the panels show, and no frame announces that — so the same path a dropped network uses (§48) is what
 * resyncs a session switch, rather than a second sync protocol the backend would have to keep in step.
 */
export function resyncFromServer(): void {
  if (!wanted) return;
  closeQuietly();
  attempt = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  open();
}

export function sendCommand(command: ClientCommand): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (command.cmd === "audio.chunk" && socket.bufferedAmount > 256 * 1024) return false;
  try { socket.send(JSON.stringify(command)); return true; }
  catch { return false; }
}

function open(): void {
  if (!wanted) return;
  const generation = ++dialGeneration;
  useSessionStore.getState().setLink("connecting", attempt);
  if (authorize) {
    void authorize().then(() => { if (wanted && generation === dialGeneration) openSocket(); }).catch(() => {
      if (wanted && generation === dialGeneration) scheduleRetry();
    });
  } else openSocket();
}

function scheduleRetry(): void {
  const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  attempt += 1;
  useSessionStore.getState().setLink("closed", attempt);
  retryTimer = setTimeout(open, delay);
}

function openSocket(): void {
  const ws = new WebSocket(target);
  socket = ws;

  // A socket that has been replaced must stay silent: its close event would otherwise start a
  // second parallel connection, and every event would reach the stores twice.
  const current = () => socket === ws;

  ws.onopen = () => {
    if (!current()) return;
    attempt = 0;
    useSessionStore.getState().setLink("open", 0);
    for (const [id, capture] of pendingCaptureEnds) {
      if (sendCommand({ cmd: "audio.capture.end", capture })) pendingCaptureEnds.delete(id);
    }
  };
  ws.onmessage = (frame: MessageEvent<string>) => {
    if (!current()) return;
    const event = decodeServerEvent(frame.data);
    if (event) dispatchEvent(event);
    else useSessionStore.getState().noteDroppedFrame();
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (!current()) return;
    socket = null;
    if (!wanted) {
      useSessionStore.getState().setLink("closed", attempt);
      return;
    }
    // The attempt is counted before the wait, so the badge describes the failure the user is seeing.
    scheduleRetry();
  };
}
