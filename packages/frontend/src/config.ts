const host = window.location.hostname || "127.0.0.1";
const backendPort = 8787;

/** The backend is loopback-only in Phase 1 and the dev server is another origin, hence absolute URLs. */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? `http://${host}:${backendPort}`;
export const WS_URL: string = import.meta.env.VITE_WS_URL ?? `ws://${host}:${backendPort}/ws`;
