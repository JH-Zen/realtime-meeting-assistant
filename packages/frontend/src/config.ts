import { backendUrls } from "./runtimeUrls";

const urls = backendUrls(window.location.href || "http://127.0.0.1:8787/", window.rccDesktop ? {} : {
  dev: import.meta.env.DEV,
  apiBase: import.meta.env.VITE_API_BASE,
  wsUrl: import.meta.env.VITE_WS_URL,
});
export const API_BASE = urls.apiBase;
export const WS_URL = urls.wsUrl;
