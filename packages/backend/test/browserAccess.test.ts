import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { request } from "node:http";
import { registerBrowserAccess } from "../src/server/browserAccess.js";

async function serve() {
  const app = Fastify();
  await app.register(websocket);
  registerBrowserAccess(app, { token: "test-credential", instanceId: "test-instance" });
  app.get("/health", () => ({ ok: true, privateModes: "mock" }));
  app.get("/api/session", () => ({ sessionId: "private-session" }));
  app.get("/ws", { websocket: true }, (socket) => socket.send("authenticated"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { app, base: `http://127.0.0.1:${address.port}` };
}

describe("local browser access", () => {
  it("requires an HttpOnly session credential for data and never uses wildcard CORS", async () => {
    const { app, base } = await serve();
    try {
      expect((await fetch(`${base}/api/session`)).status).toBe(403);
      const publicHealth = await (await fetch(`${base}/health`)).json();
      expect(publicHealth).toEqual({ ok: true, app: "rcc", ready: true, instanceId: "test-instance" });
      expect((await fetch(`${base}/api/access`, { headers: { origin: "https://untrusted.invalid" } })).status).toBe(403);
      const access = await fetch(`${base}/api/access`, { headers: { origin: "http://127.0.0.1:5173" } });
      expect(access.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
      expect(access.headers.get("access-control-allow-credentials")).toBe("true");
      const setCookie = access.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("HttpOnly; SameSite=Strict");
      const headers = { cookie: setCookie.split(";")[0] ?? "" };
      expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
      expect((await fetch(`${base}/api/session`, { headers: { ...headers, origin: "null" } })).status).toBe(403);
      expect((await fetch(`${base}/api/session`, { headers: { ...headers, origin: "https://untrusted.invalid" } })).status).toBe(403);
      const badHostStatus = await new Promise<number | undefined>((done, fail) => {
        const probe = request(`${base}/api/session`, { headers: { ...headers, host: "rebound.invalid" } }, (response) => { response.resume(); done(response.statusCode); });
        probe.on("error", fail); probe.end();
      });
      expect(badHostStatus).toBe(403);
    } finally { await app.close(); }
  });
  it("refuses unknown WS origins and allows the credentialed application", async () => {
    const { app, base } = await serve();
    try {
      const access = await fetch(`${base}/api/access`);
      const cookie = access.headers.get("set-cookie")?.split(";")[0] ?? "";
      const connect = (origin: string, credential: string) => new Promise<string>((done) => {
        const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws`, { origin, headers: { cookie: credential } });
        socket.once("message", () => { socket.close(); done("accepted"); });
        socket.once("error", () => done("refused"));
      });
      expect(await connect("https://untrusted.invalid", cookie)).toBe("refused");
      expect(await connect(base, "")).toBe("refused");
      expect(await connect(base, cookie)).toBe("accepted");
    } finally { await app.close(); }
  });
});
