export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: "include" });
}

export async function authorizeBrowser(apiBase: string): Promise<void> {
  if (window.rccDesktop) return;
  const response = await apiFetch(`${apiBase}/api/access`);
  if (!response.ok) throw new Error(`本地访问初始化失败（HTTP ${response.status}）`);
}
