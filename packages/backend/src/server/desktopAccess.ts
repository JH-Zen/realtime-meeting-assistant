import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** Desktop-only gate; the legacy browser entry still has its separately documented access limitations. */
export function registerDesktopAccess(app: FastifyInstance, token: string): void {
  const expected = Buffer.from(token);
  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers["x-rcc-desktop"];
    const supplied = Buffer.from(typeof header === "string" ? header : "");
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    if (
      supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ||
      request.headers.host !== origin.slice("http://".length) ||
      (request.headers.origin !== undefined && request.headers.origin !== origin)
    ) {
      await reply.code(403).send({ error: "desktop_access_denied" });
    }
  });
  app.addHook("onSend", async (_request, reply) => {
    const address = app.server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    reply.header("content-security-policy", [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:", "worker-src 'self' blob:",
      `connect-src 'self' ws://127.0.0.1:${port}`, "object-src 'none'", "base-uri 'none'",
      "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'",
    ].join("; "));
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), display-capture=(), microphone=(self)");
  });
}
