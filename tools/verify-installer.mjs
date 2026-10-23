import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const installer = resolve(option("installer") ?? "outputs/releases/v0.1.0-preview.1/RCC-Core-Setup.exe");
const testRoot = resolve(option("work") ?? "work/installer-smoke");
const target = join(testRoot, "installed app");
if (existsSync(target)) throw new Error(`Use a new verification directory: ${target}`);
await mkdir(testRoot, { recursive: true });

function install() {
  const result = spawnSync(installer, [`--target=${target}`, "--quiet"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
}

install();
for (const path of ["LICENSE", "runtime/LICENSE", "runtime/node.exe", "RCC.bat", "RCC-stop.bat"]) {
  assert.ok(existsSync(join(target, path)), `Missing installed file: ${path}`);
}
const envFile = join(target, ".env");
const initialEnv = await readFile(envFile, "utf8");
assert.match(initialEnv, /^LLM_API_KEY=\s*$/m);
const savedEnv = `${initialEnv}\n# Installer verification marker\nQA_MIN_INTERVAL_MS=4321\n`;
await writeFile(envFile, savedEnv);
install();
assert.equal(await readFile(envFile, "utf8"), savedEnv, "Reinstall overwrote user settings");

const portServer = createServer();
await new Promise((done, fail) => {
  portServer.once("error", fail);
  portServer.listen(0, "127.0.0.1", done);
});
const port = portServer.address().port;
await new Promise((done) => portServer.close(done));
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(port),
  DB_PATH: join(testRoot, "smoke.sqlite"),
  MOCK_STT: "true",
  MOCK_LLM: "true",
  MOCK_EMBEDDING: "true",
  MOCK_STT_SPEED: "100",
  LLM_API_KEY: "",
};
delete env.GH_TOKEN;
delete env.GITHUB_TOKEN;
const node = join(target, "runtime", "node.exe");
const backend = spawn(node, [join(target, "packages/backend/dist/index.js")], {
  cwd: target,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
for (const stream of [backend.stdout, backend.stderr]) {
  stream.on("data", (chunk) => { log = (log + chunk.toString()).slice(-8000); });
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, timeoutMs = 25_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (backend.exitCode !== null) throw new Error(`Installed backend exited: ${log}`);
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (backend.exitCode !== null) throw error;
    }
    await wait(100);
  }
  throw new Error(`Installed application timed out: ${log}`);
}

let socket;
try {
  await until(async () => {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? response.json() : null;
  });
  // New browser builds require an HttpOnly cookie; older installers have no bootstrap route.
  const access = await fetch(`${base}/api/access`);
  const cookie = access.ok ? access.headers.get("set-cookie")?.split(";")[0] : undefined;
  const headers = cookie ? { cookie } : {};
  const health = await (await fetch(`${base}/health`, { headers })).json();
  assert.equal(health.mockStt, true);
  assert.equal(health.mockLlm, true);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const events = [];
  socket.addEventListener("message", (event) => events.push(JSON.parse(event.data)));
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  socket.send(JSON.stringify({ cmd: "recording.start", source: "mock" }));
  const session = await until(async () => {
    const value = await (await fetch(`${base}/api/session`, { headers })).json();
    return value.segments?.length > 0 && value.nodes?.length > 0 ? value : null;
  });
  socket.send(JSON.stringify({ cmd: "question.ask", questionId: "release-smoke", text: "刚才讲了什么？" }));
  const answer = await until(() => events.find((event) => event.kind === "answer.completed"));
  assert.ok(answer.text.length > 0);
  socket.send(JSON.stringify({ cmd: "recording.stop" }));
  await until(() => events.find((event) => event.kind === "recording.stopped"));
  const response = await fetch(`${base}/api/session/${session.sessionId}/export`, { headers });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.schemaVersion, 1);
  assert.ok(document.transcripts.length > 0);
  const result = {
    ok: true,
    installerSha256: createHash("sha256").update(await readFile(installer)).digest("hex"),
    nodeVersion: spawnSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim(),
    checks: ["install", "reinstall-preserves-config", "licenses", "health", "page", "mock-transcript", "mindmap", "mock-qa", "session-export"],
    transcripts: document.transcripts.length,
    nodes: document.nodes.length,
  };
  await writeFile(join(testRoot, "verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.close();
  backend.kill();
  await Promise.race([new Promise((done) => backend.once("exit", done)), wait(3000)]);
}
