import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openSync, closeSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

// Uses installed Edge (or --channel=chrome), an isolated profile/config/database, and only mock models.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const work = resolve(option("work") ?? join(root, "work", `browser-verification-${Date.now()}`));
if (existsSync(work)) throw new Error(`Use a new verification directory: ${work}`);
await mkdir(work, { recursive: true });
const config = join(work, ".env");
await writeFile(config, "# isolated mock verification\n");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch (last) { error = last; }
    await wait(100);
  }
  throw new Error(`Browser verification timed out${error ? `: ${error.message}` : ""}`);
}
const children = new Set();
function child(args, cwd, env, logfile) {
  const output = openSync(logfile, "a");
  const processChild = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", output, output] });
  closeSync(output);
  children.add(processChild);
  processChild.once("exit", () => children.delete(processChild));
  return processChild;
}
async function stop(processChild) {
  if (processChild.exitCode !== null || processChild.signalCode !== null) return;
  const exited = new Promise((done) => processChild.once("exit", done));
  // These are handles created above, never a PID file or an image-name match.
  processChild.kill();
  await exited;
}
const common = { ...process.env, RCC_CONFIG_FILE: config, MOCK_STT: "true", MOCK_LLM: "true", MOCK_EMBEDDING: "true", MOCK_STT_SPEED: "60", MOCK_STT_REPEAT: "0", MINDMAP_MIN_SEGMENTS: "2", QA_MIN_INTERVAL_MS: "0", DB_PATH: join(work, "browser.sqlite"), STATIC_DIR: join(root, "packages/frontend/dist"), LLM_API_KEY: "", HOST: "127.0.0.1" };
for (const name of ["RCC_DESKTOP_INSTANCE", "RCC_DESKTOP_TOKEN", "RCC_DESKTOP_DATA_ROOT"]) delete common[name];
let starts = 0;
async function backend(port = 0) {
  const logfile = join(work, `backend-${++starts}.log`);
  const processChild = child([join(root, "packages/backend/dist/index.js")], root, { ...common, PORT: String(port) }, logfile);
  const base = await until(async () => {
    if (processChild.exitCode !== null) throw new Error(await readFile(logfile, "utf8"));
    const lines = (await readFile(logfile, "utf8")).trim().split(/\r?\n/);
    for (const line of lines) {
      try { const record = JSON.parse(line); if (record.message === "backend listening") return record.url; } catch { /* runtime warnings aren't JSON */ }
    }
    return null;
  });
  return { processChild, base };
}
const checks = [];
const result = { ok: false, checks, work, realStt: "not-tested", hardwareMicrophone: "not-tested", paidModels: "not-called" };
let browser;
const hostile = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Isolated untrusted origin probe</title>"); });
try {
  let service = await backend();
  const port = Number(new URL(service.base).port);
  assert.equal((await fetch(`${service.base}/api/session`)).status, 403);
  const firstIdentity = (await (await fetch(`${service.base}/health`)).json()).instanceId;
  browser = await chromium.launch({ channel: option("channel") ?? "msedge", headless: true });
  result.browser = browser.version();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sockets = [];
  page.on("websocket", (socket) => { if (socket.url().endsWith("/ws")) sockets.push(socket); });
  await page.goto(service.base);
  const start = page.getByRole("button", { name: "模拟讲解", exact: true });
  await until(() => start.isEnabled());
  const cookies = await context.cookies();
  assert.ok(cookies.some((cookie) => cookie.name === `rcc_access_${port}` && cookie.httpOnly && cookie.sameSite === "Strict"));
  assert.ok(!(await page.evaluate(() => document.cookie)).includes("rcc_access"));
  assert.equal(await page.evaluate(async () => (await fetch("/api/session")).status), 200);
  checks.push("built-business-page", "httponly-strict-cookie-bootstrap", "credentialed-browser-websocket");
  await start.click();
  await until(() => page.evaluate(async () => (await (await fetch("/api/session")).json()).segments.length > 0));
  await page.getByRole("button", { name: "结束", exact: true }).click();
  await until(() => page.evaluate(async () => (await (await fetch("/api/session")).json()).state === "viewing"));
  await page.getByRole("button", { name: "关闭会议", exact: true }).click();
  await until(() => page.evaluate(async () => (await (await fetch("/api/session")).json()).state === "idle"));
  await stop(service.processChild);
  service = await backend(port);
  const secondIdentity = (await (await fetch(`${service.base}/health`)).json()).instanceId;
  assert.notEqual(secondIdentity, firstIdentity);
  await until(() => sockets.length >= 2 && start.isEnabled());
  await start.click();
  await until(() => page.evaluate(async () => (await (await fetch("/api/session")).json()).segments.length > 0));
  await page.getByRole("button", { name: "结束", exact: true }).click();
  await until(() => start.isEnabled());
  checks.push("restart-refreshes-access-cookie-without-page-reload");

  await new Promise((done, fail) => { hostile.once("error", fail); hostile.listen(0, "127.0.0.1", done); });
  const untrusted = await context.newPage();
  await untrusted.goto(`http://127.0.0.1:${hostile.address().port}`);
  assert.equal(await untrusted.evaluate(async (base) => fetch(`${base}/api/session`, { credentials: "include" }).then(() => "allowed", () => "refused"), service.base), "refused");
  assert.equal(await untrusted.evaluate((base) => new Promise((done) => {
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws`);
    const deadline = setTimeout(() => { socket.close(); done("timeout"); }, 3000);
    socket.onopen = () => { clearTimeout(deadline); socket.close(); done("allowed"); };
    socket.onerror = () => { clearTimeout(deadline); done("refused"); };
  }), service.base), "refused");
  checks.push("chromium-cross-origin-http-and-websocket-refused");
  await untrusted.close();

  const viteLog = join(work, "vite.log");
  const vite = child([join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"], join(root, "packages/frontend"), { ...process.env, VITE_API_BASE: service.base, VITE_WS_URL: `${service.base.replace("http:", "ws:")}/ws` }, viteLog);
  await until(async () => {
    const log = await readFile(viteLog, "utf8");
    if (vite.exitCode !== null) throw new Error(`Vite startup failed: ${log}`);
    return log.includes("http://127.0.0.1:5173/");
  });
  const devContext = await browser.newContext();
  const dev = await devContext.newPage();
  dev.on("pageerror", (error) => errors.push(error.message));
  await dev.goto("http://127.0.0.1:5173");
  const devStart = dev.getByRole("button", { name: "模拟讲解", exact: true });
  await until(() => devStart.isEnabled());
  assert.equal(await dev.evaluate(async (base) => (await fetch(`${base}/api/session`, { credentials: "include" })).status, service.base), 200);
  await devStart.click();
  await until(() => dev.locator(".subtitle:not(.subtitle--live)").count().then((count) => count > 0));
  await dev.getByRole("button", { name: "结束", exact: true }).click();
  await until(() => devStart.isEnabled());
  await dev.screenshot({ path: join(work, "vite-business-page.png"), fullPage: true });
  checks.push("vite-cross-port-cookie-cors-websocket", "vite-real-business-mock-transcript");
  assert.deepEqual(errors, []);
  result.ok = true;
} catch (error) {
  result.error = String(error);
  throw error;
} finally {
  await browser?.close();
  await Promise.allSettled([...children].map(stop));
  if (hostile.listening) await new Promise((done) => hostile.close(done));
  await writeFile(join(work, "verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
