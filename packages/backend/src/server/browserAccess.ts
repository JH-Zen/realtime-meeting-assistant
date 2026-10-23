import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface BrowserAccessOptions { token: string; instanceId: string; }

/** Local browser bootstrap sets an HttpOnly credential; data and WS also require an allowed Origin/Host. */
export function registerBrowserAccess(app: FastifyInstance, options: BrowserAccessOptions): void {
  const expected = Buffer.from(options.token);
  const devOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
  app.addHook("onRequest", async (request, reply) => {
    const port = request.socket.localPort;
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    const allowedHost = ["127.0.0.1", "localhost", "[::1]"].some((name) => host === `${name}:${port}`);
    if (!allowedHost || (origin !== undefined && origin !== `http://${host}` && !devOrigins.has(origin))) {
      await reply.code(403).send({ error: "browser_origin_denied" });
      return;
    }
    if (origin !== undefined) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header("access-control-allow-headers", "content-type");
    }
    const path = request.url.split("?")[0];
    const cookieName = `rcc_access_${port}`;
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? "";
    const supplied = Buffer.from(cookie);
    const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (request.method === "OPTIONS") { await reply.code(204).send(); return; }
    if (request.method === "GET" && (path === "/" || path === "/api/access")) {
      reply.header("set-cookie", `${cookieName}=${options.token}; HttpOnly; SameSite=Strict; Path=/`);
      reply.header("cache-control", "no-store");
      if (path === "/api/access") await reply.send({ ok: true });
      return;
    }
    // A minimal public liveness result keeps command-line launchers usable without exposing session/config data.
    if (path === "/health" && !authorized) {
      await reply.send({ ok: true, app: "rcc", ready: true, instanceId: options.instanceId });
      return;
    }
    if (path?.startsWith("/assets/") && request.method === "GET") return;
    if (!authorized) await reply.code(403).send({ error: "browser_access_required" });
  });
  app.addHook("onSend", async (request, reply) => {
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://${request.headers.host}; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  });
}
