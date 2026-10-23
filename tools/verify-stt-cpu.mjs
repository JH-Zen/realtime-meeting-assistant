import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import WebSocket from "ws";

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const runtime = resolve(option("root") ?? "D:/Apps/实时会议助手-STT-CPU");
const executablePath = resolve(option("app") ?? "D:/Apps/实时会议助手-桌面预览/实时会议助手.exe");
const work = resolve(option("work") ?? `D:/Apps/.rcc-stt-cpu-verification/run-${Date.now()}`);
if (existsSync(work)) throw new Error(`Use a new verification directory: ${work}`);
await mkdir(work, { recursive: true });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await wait(100);
  }
  throw new Error(`CPU STT verification timed out${last ? `: ${last.message}` : ""}`);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const settings = JSON.parse(await readFile(join(runtime, "stt-cpu.json"), "utf8"));
const model = join(runtime, settings.modelDir);
const fixture = await readFile(join(model, "test_wavs/1.wav"));
assert.equal(fixture.toString("ascii", 0, 4), "RIFF");
let rate, pcm;
for (let offset = 12; offset + 8 <= fixture.length;) {
  const name = fixture.toString("ascii", offset, offset + 4);
  const size = fixture.readUInt32LE(offset + 4);
  if (name === "fmt ") { assert.equal(fixture.readUInt16LE(offset + 8), 1); assert.equal(fixture.readUInt16LE(offset + 10), 1); rate = fixture.readUInt32LE(offset + 12); assert.equal(fixture.readUInt16LE(offset + 22), 16); }
  if (name === "data") pcm = fixture.subarray(offset + 8, offset + 8 + size);
  offset += 8 + size + (size % 2);
}
assert.equal(rate, 16000);
assert.ok(pcm?.length > 0);
// Public upstream speech plus two seconds of silence, presented as a native Chromium microphone.
const wave = Buffer.alloc(44 + pcm.length + rate * 2 * 2);
wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 2, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40); pcm.copy(wave, 44);
const wav = join(work, "真实语音固定文件.wav");
await writeFile(wav, wave);
const workerLog = join(work, "worker.log");
const log = openSync(workerLog, "a");
const worker = spawn(join(runtime, ".venv/Scripts/python.exe"), ["-X", "utf8", "-u", join(runtime, "service/stt_worker.py"), "--model-dir", model, "--port", "0", "--num-threads", String(settings.threads)], { cwd: runtime, env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true, stdio: ["ignore", log, log] });
closeSync(log);
const workerExited = new Promise((done) => worker.once("exit", done));
const checks = [];
const result = { ok: false, checks, work, provider: "cpu", model: model.split(/[\\/]/).at(-1), threads: settings.threads, realStt: "upstream-fixed-speech", hardwareMicrophone: "not-tested", paidModels: "not-called", llm: "mock", embedding: "mock" };
let application;
const sockets = new Set();
async function connect(url) {
  const socket = new WebSocket(url);
  const events = [];
  sockets.add(socket);
  socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  socket.on("close", () => sockets.delete(socket));
  await new Promise((done, fail) => { socket.once("open", done); socket.once("error", fail); });
  return { socket, events };
}
async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((done) => socket.once("close", done));
  socket.close();
  await closed;
}
try {
  const url = await until(async () => {
    assert.equal(worker.exitCode, null, "Real CPU worker exited during startup");
    return (await readFile(workerLog, "utf8")).match(/listening (ws:\/\/127\.0\.0\.1:\d+)/)?.[1];
  });
  await new Promise((done, fail) => {
    const browserSocket = new WebSocket(url, { origin: "https://untrusted.invalid", handshakeTimeout: 3000 });
    browserSocket.once("open", () => { browserSocket.close(); fail(new Error("Worker accepted an untrusted browser Origin")); });
    browserSocket.once("error", (error) => { if (/403/.test(error.message)) done(); else fail(error); });
  });
  checks.push("worker-refuses-direct-browser-origin");
  const direct = await connect(url);
  const ready = await until(() => direct.events.find((event) => event.type === "ready"));
  assert.equal(ready.provider, "cpu"); assert.equal(ready.numThreads, settings.threads); assert.equal(ready.sampleRate, 16000);
  const busy = await connect(url);
  await until(() => busy.events.some((event) => event.type === "error" && event.code === "busy"));
  await closeSocket(busy.socket);
  for (let offset = 0; offset < pcm.length; offset += 3200) direct.socket.send(pcm.subarray(offset, offset + 3200));
  direct.socket.send(JSON.stringify({ type: "flush" }));
  await until(() => direct.events.some((event) => event.type === "flushed"));
  const directText = direct.events.filter((event) => event.type === "final").map((event) => event.text).join(" ");
  assert.match(directText, /ALWAYS/); assert.match(directText, /什么意思/);
  result.directTranscript = directText;
  await closeSocket(direct.socket);
  // A client lost around ready must not leave the single-client gate stuck.
  for (let attempt = 0; attempt < 3; attempt++) { const probe = await connect(url); await closeSocket(probe.socket); }
  const available = await connect(url); await until(() => available.events.some((event) => event.type === "ready")); await closeSocket(available.socket);
  checks.push("real-cpu-worker-protocol-and-final", "single-client-busy-without-takeover", "flush-preserves-spoken-tail", "disconnect-around-ready-releases-worker-slot");

  const userData = join(work, "用户 data");
  await mkdir(userData);
  await writeFile(join(userData, ".env"), `MOCK_STT=false\nSTT_WS_URL=${url}\nMOCK_LLM=true\nMOCK_EMBEDDING=true\nMINDMAP_MIN_SEGMENTS=1\nQA_MIN_INTERVAL_MS=0\n`);
  const env = { ...process.env, RCC_DESKTOP_USER_DATA: userData, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` };
  delete env.ELECTRON_RUN_AS_NODE; delete env.RCC_DESKTOP_NODE;
  application = await electron.launch({ executablePath, args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`], cwd: dirname(executablePath), env, timeout: 30_000 });
  result.desktopVersion = await application.evaluate(({ app }) => app.getVersion());
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async (_window, options) => ({ response: options.buttons?.includes("结束并退出") ? 1 : 0, checkboxChecked: false }); });
  const page = await application.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let audioFrames = 0;
  let firstAudioAt = 0;
  let firstPartialAt = 0;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { if (typeof payload === "string" && payload.includes('"audio.chunk"')) { audioFrames++; firstAudioAt ||= Date.now(); } });
    socket.on("framereceived", ({ payload }) => { if (typeof payload === "string" && payload.includes('"transcript.partial"')) firstPartialAt ||= Date.now(); });
  });
  const mic = page.getByRole("button", { name: "麦克风录音", exact: true });
  await until(() => mic.isEnabled());
  await page.getByText(/语音配置 真实 · 问答 模拟 · 检索 模拟/).waitFor();
  await page.evaluate(() => {
    window.__tracks = [];
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => { const stream = await get(constraints); window.__tracks.push(...stream.getTracks()); return stream; };
  });
  const snapshot = () => page.evaluate(async () => (await fetch("/api/session")).json());
  await mic.click();
  const initial = await until(async () => { const value = await snapshot(); return value.segments.some((segment) => /ALWAYS/i.test(segment.text)) ? value : null; });
  checks.push("installed-desktop-real-stt-mode", "native-file-microphone-worklet-upload-to-real-recognizer");
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await until(() => page.evaluate(() => window.__tracks.length > 0 && window.__tracks.every((track) => track.readyState === "ended")));
  await wait(300); const framesAtPause = audioFrames; await wait(700); assert.equal(audioFrames, framesAtPause);
  const countAtPause = (await snapshot()).segments.length;
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await until(async () => (await snapshot()).segments.length > countAtPause);
  checks.push("pause-releases-native-device-and-stops-upload", "resume-uses-existing-single-client-recognizer");
  await page.screenshot({ path: join(work, "real-cpu-transcript.png"), fullPage: true });
  await page.getByRole("button", { name: "结束", exact: true }).click();
  await until(async () => (await snapshot()).state === "viewing");
  assert.equal((await snapshot()).sessionId, initial.sessionId);
  assert.ok(await page.getByRole("button", { name: "模拟讲解", exact: true }).isEnabled());
  checks.push("real-stt-end-retains-review-session");
  await page.getByRole("button", { name: "关闭会议", exact: true }).click();
  await until(async () => (await snapshot()).state === "idle");
  const exported = await page.evaluate(async (id) => (await fetch(`/api/session/${id}/export`)).json(), initial.sessionId);
  assert.ok(exported.transcripts.length >= 2);
  assert.match(exported.transcripts.map((segment) => segment.text).join(" "), /ALWAYS/);
  await writeFile(join(work, "fixed-speech-session.json"), JSON.stringify(exported, null, 2));
  result.transcripts = exported.transcripts.map((segment) => ({ text: segment.text, startTime: segment.startTime, endTime: segment.endTime }));
  result.firstPartialAfterUploadMs = firstPartialAt && firstAudioAt ? firstPartialAt - firstAudioAt : null;
  assert.deepEqual(errors, []);
  checks.push("real-transcript-persisted-and-exported", "stop-completes-without-reviving-old-recording");
  const closed = application.waitForEvent("close");
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  application = undefined;
  const desktopLog = await readFile(join(userData, "logs/desktop.log"), "utf8");
  const pids = [...desktopLog.matchAll(/backend ready pid=(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(pids.length, 1);
  for (const pid of pids) await until(() => !alive(pid));
  for (const name of await readdir(join(userData, "logs"))) if (name.startsWith("backend-")) assert.ok((await readFile(join(userData, "logs", name), "utf8")).includes("backend cleanup complete"));
  assert.equal(worker.exitCode, null);
  const retained = await connect(url); await until(() => retained.events.some((event) => event.type === "ready")); await closeSocket(retained.socket);
  checks.push("normal-desktop-exit-closes-owned-backend", "independent-real-worker-remains-available");
  result.ok = true;
} catch (error) { result.error = String(error); throw error; }
finally {
  if (application) try { await application.close(); } catch { /* already closed */ }
  for (const socket of sockets) socket.terminate();
  if (worker.exitCode === null && worker.signalCode === null) worker.kill();
  await workerExited;
  result.testWorkerExited = !alive(worker.pid);
  await writeFile(join(work, "verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
