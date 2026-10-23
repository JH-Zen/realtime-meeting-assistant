import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedBackend } from "../src/backend";

const owned: ManagedBackend[] = [];
afterEach(async () => { for (const backend of owned.splice(0)) await backend.stop(); });

async function start(root = resolve("."), timeout = 5000) {
  const userData = await mkdtemp(join(tmpdir(), "RCC 桌面测试-"));
  await writeFile(join(userData, ".env"), "MOCK_STT=true\nMOCK_LLM=true\nMOCK_EMBEDDING=true\n");
  const backend = new ManagedBackend({ node: process.execPath, root, userData, onUnexpectedExit: () => undefined, startupTimeoutMs: timeout, shutdownTimeoutMs: 1000 });
  owned.push(backend);
  return { backend, userData };
}

describe("desktop-owned backend", () => {
  it("verifies its child, isolates HTTP/WS access, and closes SQLite through IPC", async () => {
    const { backend, userData } = await start();
    const url = await backend.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Number(new URL(url).port)).not.toBe(8787);
    const headers = { "x-rcc-desktop": backend.token };
    expect((await fetch(`${url}/health`)).status).toBe(403);
    expect((await fetch(`${url}/api/session`, { headers: { ...headers, origin: "https://untrusted.invalid" } })).status).toBe(403);
    const health = await (await fetch(`${url}/health`, { headers })).json();
    expect(health.instanceId).toBe(backend.instanceId);
    expect(health.pid).toBe(backend.child?.pid);
    expect(await backend.state()).toBe("idle");
    const blockedWs = new WebSocket(`${url.replace("http:", "ws:")}/ws`);
    const wsResult = await new Promise<string>((done) => { blockedWs.addEventListener("error", () => done("refused")); blockedWs.addEventListener("open", () => { blockedWs.close(); done("opened"); }); });
    expect(wsResult).toBe("refused");
    const pid = backend.child?.pid;
    await backend.stop();
    expect(backend.child?.exitCode).toBe(0);
    expect(await readFile(backend.logFile, "utf8")).toContain("backend cleanup complete");
    expect(() => process.kill(pid as number, 0)).toThrow();
    expect((await readFile(join(userData, "data", "rcc.sqlite"))).length).toBeGreaterThan(0);
  }, 15_000);

  it("does not trust a health-like IPC message from the wrong instance and reaps a hung child", async () => {
    const root = await mkdtemp(join(tmpdir(), "RCC 假后台-"));
    await mkdir(join(root, "packages/backend/dist"), { recursive: true });
    await writeFile(join(root, "packages/backend/dist/index.js"), "process.send({type:'rcc.ready',instanceId:'wrong',pid:process.pid,url:'http://127.0.0.1:8787'}); setInterval(()=>{},1000);");
    const { backend } = await start(root, 200);
    await expect(backend.start()).rejects.toThrow("未收到本实例");
    expect(backend.url).toBe("");
    expect(backend.child?.exitCode !== null || backend.child?.signalCode !== null).toBe(true);
    expect(await readFile(backend.logFile, "utf8")).toContain("terminating owned child only");
  }, 5000);

  it("cleans up when the parent IPC channel disappears", async () => {
    const { backend } = await start();
    await backend.start();
    backend.child?.disconnect();
    await new Promise<void>((done) => backend.child?.once("exit", () => done()));
    expect(backend.child?.exitCode).toBe(0);
    const log = await readFile(backend.logFile, "utf8");
    expect(log).toContain("desktop-disconnected");
    expect(log).toContain("backend cleanup complete");
  });

  it("reports a missing runtime as failure instead of leaving a fake ready window", async () => {
    const { backend } = await start();
    // A deliberately missing entry exercises early child exit without changing the developer's source.
    const root = await mkdtemp(join(tmpdir(), "RCC 缺失后台-"));
    const failed = new ManagedBackend({ node: process.execPath, root, userData: join(root, "用户数据"), onUnexpectedExit: () => undefined, shutdownTimeoutMs: 500 });
    owned.push(failed);
    await expect(failed.start()).rejects.toThrow("后台启动失败");
    expect(failed.url).toBe("");
    expect(backend.child).toBeUndefined();
  });
});
