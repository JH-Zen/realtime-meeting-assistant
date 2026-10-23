/** Built apps use their serving origin; Vite keeps the existing browser backend on 8787. */
export function backendUrls(pageUrl: string, options: { dev?: boolean; apiBase?: string; wsUrl?: string } = {}) {
  const page = new URL(pageUrl);
  const base = options.apiBase ?? (options.dev ? `${page.protocol}//${page.hostname}:8787` : page.origin);
  const apiBase = base.replace(/\/$/, "");
  const ws = new URL(`${apiBase}/ws`);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  return { apiBase, wsUrl: options.wsUrl ?? ws.href };
}
