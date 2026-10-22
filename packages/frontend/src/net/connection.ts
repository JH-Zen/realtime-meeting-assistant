import { decodeServerEvent, type ClientCommand } from "@rcc/shared";
import { useSessionStore } from "../state/sessionStore";
import { dispatchEvent } from "./dispatch";

/**
 * A browser tab is another subscriber to the backend bus. Reconnects back off — 1s doubling to an 8s
 * ceiling, and never giving up, because a tab has no better answer than trying again — and every fresh
 * socket is answered with the snapshots it needs: session state, the graph including the positions the
 * user dragged, and the finals. So a dropped socket loses nothing the server knows. What it can lose
 * is an answer that finished while the socket was down, because answers stream and are not replayed;
 * the user re-asks.
 */
const MAX_BACKOFF_MS = 8000;

let socket: WebSocket | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wanted = false;
let target = "";

export function connect(url: string): void {
  wanted = true;
  target = url;
  open();
}

export function disconnect(): void {
  wanted = false;
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
  socket.send(JSON.stringify(command));
  return true;
}

function open(): void {
  if (!wanted) return;
  useSessionStore.getState().setLink("connecting", attempt);
  const ws = new WebSocket(target);
  socket = ws;

  // A socket that has been replaced must stay silent: its close event would otherwise start a
  // second parallel connection, and every event would reach the stores twice.
  const current = () => socket === ws;

  ws.onopen = () => {
    if (!current()) return;
    attempt = 0;
    useSessionStore.getState().setLink("open", 0);
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
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    attempt += 1;
    useSessionStore.getState().setLink("closed", attempt);
    retryTimer = setTimeout(open, delay);
  };
}
