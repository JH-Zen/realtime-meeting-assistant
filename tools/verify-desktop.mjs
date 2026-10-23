import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { WebSocketServer } from "ws";
import { readDesktopVersion } from "./desktop-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const installer = option("installer") ? resolve(option("installer")) : null;
const installMode = option("install-mode") ?? "quiet";
if (installMode !== "quiet" && installMode !== "wizard") throw new Error("Use --install-mode=quiet or wizard");
const work = resolve(option("work") ?? join(root, "work", `desktop-verification-${Date.now()}`));
if (existsSync(work)) throw new Error(`Use a new verification directory: ${work}`);
await mkdir(work, { recursive: true });
const checks = [];
const running = new Set();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function until(read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await wait(100);
  }
  throw new Error(`Verification timed out${last ? `: ${last.message}` : ""}`);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function readAllLiveTasks(nodeBinary, database, sessionId) {
  const result = spawnSync(nodeBinary, ["--input-type=module", "-e",
    "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});const rows=db.prepare(\"SELECT task_json FROM recovery_tasks WHERE session_id=? AND json_extract(task_json,'$.trigger')='live' ORDER BY started_at DESC,id DESC\").all(process.argv[2]);console.log(JSON.stringify(rows.map(r=>JSON.parse(r.task_json))));db.close();",
    database, sessionId], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}
async function noBackend(userData) {
  const log = await readFile(join(userData, "logs/desktop.log"), "utf8");
  const pids = [...log.matchAll(/backend ready pid=(\d+)/g)].map((match) => Number(match[1]));
  for (const pid of pids) await until(() => !alive(pid));
  return pids;
}
async function saveConfig(name, extra = "") {
  const dir = join(work, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".env"), `MOCK_STT=true\nMOCK_LLM=true\nMOCK_EMBEDDING=true\nMOCK_STT_SPEED=60\nMOCK_STT_REPEAT=0\nMINDMAP_MIN_SEGMENTS=2\nQA_MIN_INTERVAL_MS=0\n${extra}`);
  return dir;
}
const target = join(work, "安装 app 中文路径");
function install() {
  const command = installMode === "wizard" ? "powershell.exe" : installer;
  const args = installMode === "wizard" ? ["-NoProfile", "-STA", "-File", join(root, "tools/verify-real-installer.ps1"), "-Installer", installer, "-Work", work, "-Target", target, "-Version", readDesktopVersion()] : [`--target=${target}`, "--quiet", "--no-shortcut"];
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 120_000, env: { ...process.env, RCC_INSTALLER_LOG_DIR: join(work, "installer-logs") } });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
}
if (installer) {
  install();
  for (const file of ["实时会议助手.exe", "LICENSE", "LICENSES.chromium.html", "resources/backend/runtime/node.exe", "resources/backend/runtime/LICENSE", "resources/backend/LICENSE"]) assert.ok(existsSync(join(target, file)), `Missing installed file: ${file}`);
  assert.equal(existsSync(join(target, "resources/backend/.env")), false);
  assert.equal(existsSync(join(target, "resources/backend/node_modules/@huggingface/transformers")), false);
  checks.push("installer-chinese-space-path", "runtime-licenses", "no-source-env-or-real-embedding-runtime");
  if (installMode === "wizard") checks.push("full-native-installer-wizard");
}
const executablePath = installer ? join(target, "实时会议助手.exe") : require("electron");
const baseArgs = installer ? [] : [join(root, "packages/desktop")];
function environment(userData) {
  const env = { ...process.env, RCC_DESKTOP_USER_DATA: userData, RCC_DESKTOP_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  if (installer) {
    // Prove no system Node lookup is available, and don't run with the checkout as the cwd.
    env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
    delete env.RCC_DESKTOP_NODE;
  }
  return env;
}
async function launch(userData, args = [], expectBusiness = true) {
  const application = await electron.launch({ executablePath, args: [...baseArgs, ...args], cwd: installer ? target : root, env: environment(userData), timeout: 30_000 });
  running.add(application);
  application.on("close", () => running.delete(application));
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (expectBusiness) {
    await page.getByRole("button", { name: "模拟讲解", exact: true }).waitFor();
    await until(() => page.getByRole("button", { name: "模拟讲解", exact: true }).isEnabled());
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), !!installer);
    assert.ok(!page.url().includes(":8787"));
  }
  return { application, page, userData, errors };
}
async function closeApp(run, response = 1) {
  await run.application.evaluate(({ dialog }, chosen) => { dialog.showMessageBox = async () => ({ response: chosen, checkboxChecked: false }); }, response);
  const exited = run.application.waitForEvent("close");
  await run.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await exited;
  await noBackend(run.userData);
  for (const name of await (await import("node:fs/promises")).readdir(join(run.userData, "logs"))) {
    if (!name.startsWith("backend-")) continue;
    const log = await readFile(join(run.userData, "logs", name), "utf8");
    assert.ok(!log.includes("graceful shutdown timed out"), "Normal exit fell back to forced termination");
    assert.ok(log.includes("backend cleanup complete"), "Normal exit didn't finish backend cleanup");
  }
}
async function sessionOf(page) { return page.evaluate(async () => (await fetch("/api/session")).json()); }

// A pre-existing app on 8787 is deliberately left alone. Otherwise reserve it with a health lookalike.
let foreignRequests = 0;
let ownsForeign = false;
const foreign = createServer((_request, reply) => { foreignRequests++; reply.setHeader("content-type", "application/json"); reply.end('{"ok":true,"mockStt":true}'); });
await new Promise((done, fail) => {
  foreign.once("error", (error) => error.code === "EADDRINUSE" ? done() : fail(error));
  foreign.listen(8787, "127.0.0.1", () => { ownsForeign = true; done(); });
});
let receiver;
const result = { mode: installer ? "installed" : "development", checks, work, hardwareMicrophone: "not-tested", realStt: "not-tested", paidModels: "not-called" };
try {
  const userData = await saveConfig("用户 data mock");
  const run = await launch(userData);
  const { application, page } = run;
  const versionSurface = await application.evaluate(async ({ app, BrowserWindow, dialog, Menu }) => {
    const original = dialog.showMessageBox;
    let about;
    dialog.showMessageBox = async (_owner, options) => { about = options; return { response: 0, checkboxChecked: false }; };
    try { Menu.getApplicationMenu().getMenuItemById("about-rcc").click(); }
    finally { dialog.showMessageBox = original; }
    return { version: app.getVersion(), title: BrowserWindow.getAllWindows()[0].getTitle(), about };
  });
  assert.ok(versionSurface.title.includes(versionSurface.version));
  assert.ok(versionSurface.about.detail.includes(versionSurface.version));
  result.desktopVersion = versionSurface.version;
  checks.push("version-in-window-title-and-about");
  result.runtime = await application.evaluate(() => {
    let sqlite;
    try {
      const module = process.getBuiltinModule("node:sqlite");
      const db = new module.DatabaseSync(":memory:");
      db.exec("CREATE TABLE compatibility_probe (id INTEGER)"); db.close(); sqlite = "available";
    } catch (error) { sqlite = String(error); }
    return { electron: process.versions.electron, chromium: process.versions.chrome, electronNode: process.versions.node, electronSqliteProbe: sqlite, backendNode: null };
  });
  const nodePath = installer ? join(target, "resources/backend/runtime/node.exe") : process.execPath;
  result.runtime.backendNode = spawnSync(nodePath, ["--version"], { encoding: "utf8", windowsHide: true, env: environment(userData) }).stdout.trim();
  checks.push("desktop-business-page", "dynamic-loopback-port-with-8787-occupied");
  assert.equal(foreignRequests, 0, "Desktop incorrectly probed another service");
  if (ownsForeign) assert.equal((await fetch("http://127.0.0.1:8787/health")).status, 200);
  const prefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true);
  const boundary = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, popup: window.open("https://example.com") === null }));
  assert.deepEqual(boundary, { require: "undefined", process: "undefined", popup: true });
  await wait(200);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal((await fetch(`${new URL(page.url()).origin}/health`)).status, 403);
  checks.push("sandbox-no-node-no-popup", "private-desktop-http-access");

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  const duplicate = spawn(executablePath, baseArgs, { cwd: installer ? target : root, env: environment(userData), windowsHide: true, stdio: "ignore" });
  await Promise.race([new Promise((done) => duplicate.once("exit", (code) => { assert.equal(code, 0); done(); })), wait(10_000).then(() => { throw new Error("Duplicate instance did not exit"); })]);
  await until(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMinimized()));
  const instanceLog = await readFile(join(userData, "logs/desktop.log"), "utf8");
  assert.equal([...instanceLog.matchAll(/backend ready pid=/g)].length, 1);
  assert.ok(instanceLog.includes("second instance"));
  checks.push("single-instance-activates-existing-window");

  await page.getByText("语音配置 模拟 · 问答 模拟 · 检索 模拟", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.__mockMicCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__mockMicCalls++; throw new Error("Mock configuration must fail before device access"); };
  });
  await page.getByRole("button", { name: "麦克风录音", exact: true }).click();
  await page.getByText(/当前为模拟语音模式/).waitFor();
  assert.equal(await page.evaluate(() => window.__mockMicCalls), 0);
  assert.equal((await sessionOf(page)).state, "idle");
  checks.push("actual-mode-badge", "mock-mode-refuses-before-microphone-permission");
  await page.getByRole("button", { name: "模拟讲解", exact: true }).click();
  const snapshot = await until(async () => { const s = await sessionOf(page); return s.segments?.length >= 4 && s.nodes?.length > 0 ? s : null; });
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await until(async () => (await sessionOf(page)).state === "paused");
  const pausedMock = (await sessionOf(page)).segments.length;
  await wait(500);
  assert.equal((await sessionOf(page)).segments.length, pausedMock);
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await until(async () => (await sessionOf(page)).segments.length > pausedMock);
  checks.push("mock-pause-freezes-transcript", "mock-resume-retains-remaining-input");
  await page.getByRole("textbox").fill("刚才讲了什么？");
  await page.getByRole("button", { name: "提问", exact: true }).click();
  await until(() => page.evaluate(async (id) => { const s = await (await fetch(`/api/session/${id}/questions`)).json(); return s.exchanges?.some((entry) => entry.answer?.text?.length > 0); }, snapshot.sessionId));
  await page.screenshot({ path: join(work, "business-page.png"), fullPage: true });
  checks.push("mock-transcript", "mindmap", "mock-qa");

  const exportedFile = join(work, "会话导出.json");
  await application.evaluate(({ BrowserWindow }, file) => {
    BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_event, item) => item.setSavePath(file));
  }, exportedFile);
  await page.getByRole("button", { name: "导出会话", exact: true }).click();
  const document = await until(async () => { const value = JSON.parse(await readFile(exportedFile, "utf8")); return value.transcripts?.length > 0 ? value : null; });
  assert.equal(document.schemaVersion, 1);
  await page.getByRole("button", { name: "结束", exact: true }).click();
  const reviewed = await until(async () => { const s = await sessionOf(page); return s.state === "viewing" ? s : null; });
  assert.equal(reviewed.sessionId, snapshot.sessionId);
  assert.ok(reviewed.segments.length >= document.transcripts.length);
  const visibleLiveTasks = await page.evaluate(async (id) => (await (await fetch(`/api/session/${id}/recovery-tasks?scope=live`)).json()).tasks, reviewed.sessionId);
  // The UI deliberately shows the latest ten; prove complete persistence using a read-only query
  // of this verifier's own database, rather than mistaking a bounded window for missing audit rows.
  const auditNode = installer ? join(target, "resources/backend/runtime/node.exe") : process.execPath;
  const auditDatabase = join(userData, "data/rcc.sqlite");
  const liveTasks = readAllLiveTasks(auditNode, auditDatabase, reviewed.sessionId);
  assert.deepEqual(visibleLiveTasks, liveTasks.slice(0, 10));
  const sourceIds = new Set(reviewed.segments.map((segment) => segment.id));
  for (const kind of ["retrieval", "mindmap"]) {
    const tasks = liveTasks.filter((task) => task.kind === kind);
    assert.ok(tasks.length > 0);
    const covered = new Set();
    for (const task of tasks) {
      assert.equal(task.trigger, "live");
      assert.equal(task.status, "succeeded");
      assert.equal(task.remaining, 0);
      assert.equal(task.attempts.length, 1);
      assert.equal(task.sourceSegmentIds.length, task.initialMissing);
      assert.ok(task.sourceSegmentIds.length <= 512);
      for (const id of task.sourceSegmentIds) { assert.ok(sourceIds.has(id)); covered.add(id); }
    }
    assert.deepEqual([...covered].sort(), [...sourceIds].sort());
  }
  const livePanel = page.getByRole("region", { name: "处理任务记录", exact: true });
  await livePanel.locator(":scope > details > summary").click();
  await livePanel.getByRole("combobox", { name: "任务记录范围" }).selectOption("live");
  await livePanel.getByText(/本批已确认处理/).first().waitFor();
  await page.screenshot({ path: join(work, "live-tasks.png"), fullPage: true });
  await livePanel.getByRole("combobox", { name: "任务记录范围" }).selectOption("manual");
  await livePanel.getByText(/所选范围尚无本机任务记录/).waitFor();
  result.liveTasks = liveTasks;
  checks.push("live-derived-tasks-preserve-all-mock-source-identities", "native-live-and-manual-task-filter");
  const reviewQuestion = "结束后还能依据这场会议继续提问吗？";
  await page.getByRole("textbox").fill(reviewQuestion);
  await page.getByRole("button", { name: "提问", exact: true }).click();
  await until(() => page.evaluate(async (id) => (await (await fetch(`/api/session/${id}/questions`)).json()).exchanges?.some((entry) => entry.question.text === "结束后还能依据这场会议继续提问吗？" && entry.answer?.text?.length > 0), snapshot.sessionId));
  const beforeRefresh = await sessionOf(page);
  await page.reload();
  await page.getByText(reviewQuestion, { exact: true }).waitFor();
  const afterRefresh = await sessionOf(page);
  assert.equal(afterRefresh.sessionId, beforeRefresh.sessionId);
  assert.equal(afterRefresh.state, "viewing");
  assert.deepEqual(afterRefresh.segments, beforeRefresh.segments);
  assert.deepEqual(afterRefresh.nodes, beforeRefresh.nodes);
  await page.screenshot({ path: join(work, "review-after-refresh.png"), fullPage: true });
  checks.push("end-retains-askable-meeting", "refresh-restores-same-transcript-map-and-qa");
  await page.getByRole("button", { name: "关闭会议", exact: true }).click();
  await until(async () => (await sessionOf(page)).state === "idle");
  await until(() => page.locator(".subtitle").count().then((count) => count === 0));
  assert.equal(await page.locator(".answer").count(), 0);
  assert.equal(await page.locator(".mind-node").count(), 0);
  checks.push("close-meeting-clears-all-visible-session-state");
  await page.locator('input[type="file"]').setInputFiles(exportedFile);
  const imported = await until(async () => { const s = await sessionOf(page); return s.state === "viewing" && s.sessionId !== snapshot.sessionId ? s : null; });
  assert.equal(imported.segments.length, document.transcripts.length);
  assert.equal(imported.nodes.length, document.nodes.length);
  await page.locator(".session-history summary").click();
  await page.locator(`li[data-session-id="${snapshot.sessionId}"] button`).click();
  await page.getByText(reviewQuestion, { exact: true }).waitFor();
  assert.equal((await sessionOf(page)).sessionId, snapshot.sessionId);
  await page.locator(`li[data-session-id="${imported.sessionId}"] button`).click();
  await until(async () => (await sessionOf(page)).sessionId === imported.sessionId);
  await until(() => page.getByText(reviewQuestion, { exact: true }).count().then((count) => count === 0));
  checks.push("actual-local-meeting-list-switch-without-old-qa");
  checks.push("real-ui-json-download", "real-ui-json-import");
  assert.deepEqual(run.errors, []);
  result.transcripts = document.transcripts.length;
  result.nodes = document.nodes.length;
  // Electron cancels this before navigation; Playwright otherwise retains a pending navigation barrier
  // on later locator actions. Test it after the business actions and verify the live API still works.
  const controlledUrl = page.url();
  await page.evaluate(() => { window.location.href = "https://example.com"; });
  await wait(200);
  assert.equal(page.url(), controlledUrl);
  assert.equal(await page.evaluate(() => fetch("https://example.com").then(() => false, () => true)), true);
  assert.equal((await sessionOf(page)).sessionId, imported.sessionId);
  checks.push("external-navigation-and-network-blocked");
  await closeApp(run);
  checks.push("normal-ipc-exit-no-owned-backend");

  // Remove one derived vector only in this verifier's isolated profile, after its backend exits.
  // This simulates missing durable work without changing text or using a pretend page/provider.
  const testDatabase = join(userData, "data/rcc.sqlite");
  const testNode = installer ? join(target, "resources/backend/runtime/node.exe") : process.execPath;
  const removeVector = spawnSync(testNode, ["--input-type=module", "-e",
    "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);const row=db.prepare(\"SELECT rowid FROM embeddings WHERE session_id=? AND owner_type='transcript' ORDER BY rowid LIMIT 1\").get(process.argv[2]);if(!row)throw Error('No test embedding to remove');db.prepare('DELETE FROM embeddings WHERE rowid=?').run(row.rowid);db.close();",
    testDatabase, imported.sessionId], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(removeVector.status, 0, removeVector.stderr || String(removeVector.error));
  const removeGraphLeaf = spawnSync(testNode, ["--input-type=module", "-e",
    "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);const id=process.argv[2];const leaf=db.prepare('SELECT id FROM mindmap_nodes n WHERE session_id=? AND NOT EXISTS(SELECT 1 FROM mindmap_nodes c WHERE c.session_id=n.session_id AND c.parent_id=n.id) ORDER BY created_at DESC LIMIT 1').get(id);if(!leaf)throw Error('No isolated graph leaf');db.exec('BEGIN');db.prepare('DELETE FROM mindmap_edges WHERE session_id=? AND (source=? OR target=?)').run(id,leaf.id,leaf.id);db.prepare('DELETE FROM graph_positions WHERE session_id=? AND node_id=?').run(id,leaf.id);db.prepare('DELETE FROM mindmap_nodes WHERE session_id=? AND id=?').run(id,leaf.id);db.exec('COMMIT');db.close();",
    testDatabase, imported.sessionId], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(removeGraphLeaf.status, 0, removeGraphLeaf.stderr || String(removeGraphLeaf.error));
  // A test-owned unfinished task simulates loss of the previous backend, without model work.
  const seedTask = spawnSync(testNode, ["--input-type=module", "-e",
    "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);const startedAt=Date.now()-1000;const t={id:'verification-interrupted-task',sessionId:process.argv[2],kind:'retrieval',status:'running',startedAt,finishedAt:null,initialMissing:1,remaining:null,completedBatches:0,failureCode:null,attempts:[{batch:1,attempt:1,inputCount:1,savedCount:0,outcome:'running',startedAt,finishedAt:null}]};db.prepare('INSERT INTO recovery_tasks(id,session_id,kind,status,started_at,task_json) VALUES(?,?,?,?,?,?)').run(t.id,t.sessionId,t.kind,t.status,t.startedAt,JSON.stringify(t));db.close();",
    testDatabase, imported.sessionId], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(seedTask.status, 0, seedTask.stderr || String(seedTask.error));
  const repair = await launch(userData);
  const taskPanel = repair.page.getByRole("region", { name: "处理任务记录", exact: true });
  await taskPanel.locator(":scope > details > summary").click();
  await taskPanel.getByText("检索索引 · 任务已中断 · 1 次批次尝试", { exact: true }).click();
  await taskPanel.getByText(/上次后台退出前未完成/).waitFor();
  const startupTasks = await repair.page.evaluate(async (id) => (await (await fetch(`/api/session/${id}/recovery-tasks`)).json()).tasks, imported.sessionId);
  assert.equal(startupTasks.length, 1);
  assert.equal(startupTasks[0].status, "interrupted");
  assert.equal(startupTasks[0].attempts[0].outcome, "interrupted");
  checks.push("interrupted-repair-task-visible-without-automatic-model-work");
  const repairPanel = repair.page.getByRole("region", { name: "检索索引补建" });
  await repairPanel.getByText(/缺失 1 段/).waitFor();
  const repairBefore = await sessionOf(repair.page);
  assert.equal(repairBefore.sessionId, imported.sessionId);
  assert.equal(await repair.page.evaluate(async () => (await fetch("/api/session/not-selected/retrieval/rebuild", { method: "POST" })).status), 409);
  await repairPanel.getByRole("button", { name: "补建缺失索引", exact: true }).click();
  const recoveredIndex = await until(() => repair.page.evaluate(async (id) => {
    const s = await (await fetch(`/api/session/${id}/retrieval`)).json();
    return s.missing === 0 && !s.busy ? s : null;
  }, imported.sessionId));
  assert.equal(recoveredIndex.indexed, imported.segments.length);
  assert.deepEqual((await sessionOf(repair.page)).segments, repairBefore.segments);
  assert.deepEqual((await sessionOf(repair.page)).nodes, repairBefore.nodes);
  await repairPanel.getByText(/缺失 0 段/).waitFor();
  assert.equal(await repairPanel.getByRole("button", { name: "补建缺失索引", exact: true }).isDisabled(), true);
  assert.deepEqual(repair.errors, []);
  await repair.page.screenshot({ path: join(work, "index-recovery.png"), fullPage: true });
  result.indexRecovery = recoveredIndex;
  const graphPanel = repair.page.getByRole("region", { name: "导图补建" });
  await graphPanel.getByText(/旧版或导入导图没有处理记录/).waitFor();
  assert.equal(await repair.page.evaluate(async (id) => (await fetch(`/api/session/${id}/mindmap/rebuild`, { method: "POST" })).status, imported.sessionId), 409);
  assert.equal(await repair.page.evaluate(async () => (await fetch("/api/session/not-selected/mindmap/rebuild", { method: "POST" })).status), 409);
  await graphPanel.getByRole("button", { name: "确认可能重复并补建导图", exact: true }).click();
  const recoveredGraph = await until(() => repair.page.evaluate(async (id) => {
    const s = await (await fetch(`/api/session/${id}/mindmap/recovery`)).json();
    return s.missing === 0 && !s.busy ? s : null;
  }, imported.sessionId));
  const graphAfter = await sessionOf(repair.page);
  assert.deepEqual(graphAfter.segments, repairBefore.segments);
  assert.deepEqual(graphAfter.nodes.map((node) => node.id).sort(), imported.nodes.map((node) => node.id).sort());
  const repeated = await repair.page.evaluate(async (id) => {
    await fetch(`/api/session/${id}/mindmap/rebuild`, { method: "POST" });
    return (await fetch(`/api/session/${id}/mindmap/recovery`)).json();
  }, imported.sessionId);
  assert.equal(repeated.completedBatches, recoveredGraph.completedBatches);
  assert.equal(await graphPanel.getByRole("button", { name: "补建未处理导图", exact: true }).isDisabled(), true);
  await repair.page.screenshot({ path: join(work, "mindmap-recovery.png"), fullPage: true });
  result.mindmapRecovery = recoveredGraph;
  const auditedTasks = await until(() => repair.page.evaluate(async (id) => {
    const value = await (await fetch(`/api/session/${id}/recovery-tasks`)).json();
    return value.tasks.length === 3 && value.tasks.filter((t) => t.status === "succeeded").length === 2 ? value.tasks : null;
  }, imported.sessionId));
  for (const task of auditedTasks.filter((t) => t.status === "succeeded")) {
    assert.equal(task.remaining, 0);
    assert.ok(task.attempts.length > 0 && task.attempts.length <= 24);
    assert.equal(task.completedBatches, task.attempts.filter((a) => a.outcome === "succeeded").length);
  }
  await taskPanel.getByText(/检索索引 · 本次补建已完成/).waitFor();
  await taskPanel.getByText(/导图 · 本次补建已完成/).waitFor();
  await repair.page.screenshot({ path: join(work, "recovery-tasks.png"), fullPage: true });
  result.recoveryTasks = auditedTasks;
  checks.push("bounded-repair-attempt-history-through-native-ui");
  checks.push("explicit-mindmap-recovery-restores-isolated-missing-node", "legacy-ack-and-mindmap-rebuild-idempotency");
  await closeApp(repair);
  checks.push("explicit-index-repair-through-native-ui", "repair-preserves-source-and-rejects-stale-session");

  if (installer) {
    const dbPath = join(userData, "data/rcc.sqlite");
    const before = hash(await readFile(dbPath));
    const config = await readFile(join(userData, ".env"), "utf8");
    const legacyConfig = "# isolated reinstall marker\nCUSTOM_SETTING=preserved\n";
    await writeFile(join(target, ".env"), legacyConfig);
    await mkdir(join(target, "models"), { recursive: true });
    await writeFile(join(target, "models/keep.txt"), "user model marker");
    install();
    assert.equal(hash(await readFile(dbPath)), before);
    assert.equal(await readFile(join(userData, ".env"), "utf8"), config);
    assert.equal(await readFile(join(target, ".env"), "utf8"), legacyConfig);
    assert.equal(await readFile(join(target, "models/keep.txt"), "utf8"), "user model marker");
    const runtime = join(target, "resources/backend/runtime/node.exe");
    const query = spawnSync(runtime, ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(db.prepare('SELECT status, count(*) AS total FROM sessions GROUP BY status').all()));db.close()", dbPath], { cwd: target, env: environment(userData), windowsHide: true, encoding: "utf8" });
    assert.equal(query.status, 0, query.stderr);
    result.persistedSessions = JSON.parse(query.stdout);
    checks.push("reinstall-preserves-user-config-sqlite-and-model-markers", "bundled-node-without-system-node-path");
  }
  const reopened = await launch(userData);
  await reopened.page.getByRole("button", { name: "关闭会议", exact: true }).waitFor();
  assert.equal((await sessionOf(reopened.page)).sessionId, imported.sessionId);
  assert.equal((await sessionOf(reopened.page)).state, "viewing");
  assert.equal(await reopened.page.locator(".subtitle:not(.subtitle--live)").count(), imported.segments.length);
  assert.equal(await reopened.page.evaluate(async (id) => (await (await fetch(`/api/session/${id}/mindmap/recovery`)).json()).missing, imported.sessionId), 0);
  checks.push("mindmap-checkpoints-survive-backend-restart");
  const restoredTasks = await reopened.page.evaluate(async (id) => (await (await fetch(`/api/session/${id}/recovery-tasks`)).json()).tasks, imported.sessionId);
  assert.deepEqual(restoredTasks, auditedTasks);
  const restoredLive = await reopened.page.evaluate(async (id) => {
    const opened = await fetch(`/api/session/${id}/open`, { method: "POST" });
    if (!opened.ok) throw new Error("Cannot reopen the isolated live meeting");
    return (await (await fetch(`/api/session/${id}/recovery-tasks?scope=live`)).json()).tasks;
  }, reviewed.sessionId);
  assert.deepEqual(restoredLive, visibleLiveTasks);
  assert.deepEqual(readAllLiveTasks(auditNode, auditDatabase, reviewed.sessionId), liveTasks);
  assert.equal(await reopened.page.evaluate(async (id) => (await fetch(`/api/session/${id}/open`, { method: "POST" })).status, imported.sessionId), 200);
  checks.push("live-task-history-survives-backend-restart");
  if (installer) checks.push("reinstall-preserves-nonempty-live-task-history");
  checks.push("repair-task-history-survives-backend-restart");
  if (installer) checks.push("reinstall-preserves-nonempty-repair-task-history");
  checks.push("restart-restores-selected-meeting-without-capture");
  await closeApp(reopened);
  checks.push("restart-after-exit");

  const failedData = await saveConfig("启动失败", "MOCK_STT_SPEED=invalid\n");
  const failed = await launch(failedData, [], false);
  await failed.page.getByRole("heading", { name: "启动或运行失败" }).waitFor();
  assert.ok((await failed.page.locator("#logs").textContent()).includes(failedData));
  await failed.page.screenshot({ path: join(work, "startup-error.png") });
  await failed.page.getByRole("button", { name: "退出应用" }).click();
  await until(() => !running.has(failed.application));
  await noBackend(failedData);
  checks.push("backend-start-failure-visible-with-logs");

  const missingData = await saveConfig("缺少真实识别服务", "MOCK_STT=false\nSTT_WS_URL=ws://127.0.0.1:1\n");
  const missing = await launch(missingData);
  await missing.page.evaluate(() => {
    window.__missingMicCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__missingMicCalls++; throw new Error("Unavailable worker must fail before device access"); };
  });
  await missing.page.getByRole("button", { name: "麦克风录音", exact: true }).click();
  await missing.page.getByText(/无法连接本地 STT worker/).waitFor();
  assert.equal(await missing.page.evaluate(() => window.__missingMicCalls), 0);
  assert.equal((await sessionOf(missing.page)).state, "idle");
  await closeApp(missing);
  checks.push("missing-worker-refuses-before-microphone-permission");

  // Fixed 48 kHz audio goes through Chromium getUserMedia + the existing AudioWorklet.
  // This receiver is deliberately NOT a recognizer and never returns transcripts.
  const frames = [];
  receiver = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((done) => receiver.once("listening", done));
  let activeReceiver = null;
  receiver.on("connection", (socket) => {
    if (activeReceiver) { socket.send(JSON.stringify({ type: "error", code: "busy" })); socket.close(); return; }
    activeReceiver = socket;
    socket.once("close", () => { if (activeReceiver === socket) activeReceiver = null; });
    socket.send(JSON.stringify({ type: "ready", protocol: 1, sampleRate: 16000, model: "transport-only-no-stt" }));
    socket.on("message", (raw, binary) => {
      if (binary) frames.push(Buffer.from(raw));
      else if (JSON.parse(raw.toString()).type === "flush") socket.send(JSON.stringify({ type: "flushed", finals: 0 }));
    });
  });
  const wav = join(work, "固定音频 48k.wav");
  const samples = 48000 * 8;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 1000 / 48000) * 14000), 44 + i * 2);
  await writeFile(wav, wave);
  const micData = await saveConfig("虚拟麦克风", `MOCK_STT=false\nSTT_WS_URL=ws://127.0.0.1:${receiver.address().port}\n`);
  const mic = await launch(micData, ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`]);
  assert.equal(await mic.page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => { for (const track of stream.getTracks()) track.stop(); return "allowed"; }, () => "denied")), "denied");
  checks.push("camera-denied");
  // Observe real native tracks; don't replace devices, AudioContext, worklet or upload code.
  await mic.page.evaluate(() => {
    window.__observedTracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (window.__holdMicPermission) await new Promise((done) => { window.__releaseMicPermission = done; });
      const stream = await original(constraints);
      window.__observedTracks.push(...stream.getTracks());
      return stream;
    };
  });
  await mic.application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await mic.page.getByRole("button", { name: "麦克风录音", exact: true }).click();
  await mic.page.getByText(/麦克风不可用/).waitFor();
  assert.equal((await sessionOf(mic.page)).state, "idle");
  assert.equal(frames.length, 0);
  checks.push("microphone-permission-denial-no-recording");
  await mic.application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  await mic.page.evaluate(() => { window.__holdMicPermission = true; });
  await mic.page.getByRole("button", { name: "麦克风录音", exact: true }).click();
  await until(() => mic.page.evaluate(() => typeof window.__releaseMicPermission === "function"));
  await mic.page.getByRole("button", { name: "取消准备", exact: true }).click();
  await mic.page.evaluate(() => { window.__holdMicPermission = false; window.__releaseMicPermission(); });
  await until(() => mic.page.evaluate(() => window.__observedTracks.length > 0 && window.__observedTracks.every((track) => track.readyState === "ended")));
  assert.equal((await sessionOf(mic.page)).state, "idle");
  assert.equal(frames.length, 0);
  checks.push("cancel-preparation-releases-late-native-permission-result");
  // Inject one transport loss, keeping the real native capture/resampler and all other frames.
  await mic.page.evaluate(() => {
    window.__audioFrameDropped = false;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (typeof data === "string") {
        const command = JSON.parse(data);
        if (!window.__audioFrameDropped && command.cmd === "audio.chunk" && command.capture && command.seq === 3) {
          window.__audioFrameDropped = true;
          return;
        }
      }
      return originalSend.call(this, data);
    };
  });
  await mic.page.getByRole("button", { name: "麦克风录音", exact: true }).click();
  try { await until(() => frames.length >= 12); }
  catch (error) { await mic.page.screenshot({ path: join(work, "microphone-error.png") }); throw new Error(`${error.message}; microphone: ${await mic.page.locator(".controls__notice").textContent()}`); }
  assert.ok(frames.every((frame) => frame.length === 3200), "Expected 1600 samples of 16-bit PCM per 100 ms");
  const audio = Buffer.concat(frames);
  let peak = 0;
  let positiveCrossings = 0;
  for (let i = 0; i < audio.length; i += 2) peak = Math.max(peak, Math.abs(audio.readInt16LE(i)));
  for (let i = 2; i < audio.length; i += 2) if (audio.readInt16LE(i - 2) <= 0 && audio.readInt16LE(i) > 0) positiveCrossings++;
  const frequencyHz = positiveCrossings / (audio.length / 2 / 16000);
  assert.ok(peak > 100, "Captured upload was silent");
  assert.ok(frequencyHz > 900 && frequencyHz < 1100, `Expected the input file's 1 kHz tone after resampling, got ${frequencyHz}`);
  await writeFile(join(work, "virtual-capture-16k.pcm"), audio);
  assert.equal((await sessionOf(mic.page)).segments.length, 0, "A transport receiver must not be called real STT");
  const audioSessionId = (await sessionOf(mic.page)).sessionId;
  const gapEvidence = await until(() => mic.page.evaluate(async (id) => {
    const value = await (await fetch(`/api/session/${id}/audio-gaps`)).json();
    return value.gaps?.find((gap) => gap.stage === "capture_backend" && gap.reason === "sequence_gap") ?? null;
  }, audioSessionId));
  assert.equal(gapEvidence.certainty, "observed");
  assert.ok(Math.abs(gapEvidence.startTime - 0.3) < 0.0001);
  assert.ok(Math.abs(gapEvidence.endTime - 0.4) < 0.0001);
  const gapPanel = mic.page.getByRole("region", { name: "音频缺口记录" });
  await gapPanel.locator("summary").click();
  await gapPanel.getByText(/观察到链路缺口/).waitFor();
  await mic.page.screenshot({ path: join(work, "audio-gap.png"), fullPage: true });
  const audioDocument = await mic.page.evaluate(async (id) => (await fetch(`/api/session/${id}/export`)).json(), audioSessionId);
  assert.ok(audioDocument.audioGaps.some((gap) => gap.id === gapEvidence.id));
  await mic.page.getByRole("button", { name: "暂停", exact: true }).click();
  await until(() => mic.page.evaluate(() => window.__observedTracks.every((track) => track.readyState === "ended")));
  await wait(300); const pausedFrames = frames.length; await wait(350); assert.equal(frames.length, pausedFrames);
  await mic.page.getByRole("button", { name: "继续", exact: true }).click();
  await until(() => frames.length > pausedFrames + 3);
  await mic.application.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); BrowserWindow.getAllWindows()[0].close(); });
  await wait(350);
  assert.ok(running.has(mic.application), "Cancel close did not preserve the recording window");
  await closeApp(mic);
  assert.ok(receiver.address(), "Desktop took ownership of the independently supplied worker");
  const audioReview = await launch(micData);
  const preservedGaps = await audioReview.page.evaluate(async (id) => (await (await fetch(`/api/session/${id}/audio-gaps`)).json()).gaps, audioSessionId);
  assert.ok(preservedGaps.some((gap) => gap.id === gapEvidence.id));
  const audioImported = await audioReview.page.evaluate(async (doc) => {
    const response = await fetch("/api/session/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });
    if (!response.ok) throw Error(`Audio-gap import ${response.status}`);
    return response.json();
  }, audioDocument);
  await until(async () => (await sessionOf(audioReview.page)).sessionId === audioImported.sessionId);
  const copiedGaps = await audioReview.page.evaluate(async (id) => (await (await fetch(`/api/session/${id}/audio-gaps`)).json()).gaps, audioImported.sessionId);
  assert.ok(copiedGaps.some((gap) => gap.id === gapEvidence.id && gap.sessionId === audioImported.sessionId));
  await closeApp(audioReview);
  if (installer) {
    const audioDbPath = join(micData, "data/rcc.sqlite");
    const beforeAudioDb = hash(await readFile(audioDbPath));
    install();
    assert.equal(hash(await readFile(audioDbPath)), beforeAudioDb);
    checks.push("reinstall-preserves-nonempty-audio-gap-database");
  }
  result.audioGap = { ...gapEvidence, importedSessionId: audioImported.sessionId, realRecognition: "not-performed" };
  checks.push("native-capture-missing-frame-visible", "audio-gap-export-restart-import-preserves-provenance");
  result.virtualMicrophone = { inputRate: 48000, outputRate: 16000, frames: frames.length, bytesPerFrame: 3200, peak, frequencyHz, transcription: "not-performed", permissionResponse: "automated-native-dialog-selection" };
  checks.push("virtual-file-native-capture-resample-ws-upload", "pause-releases-native-tracks", "resume-capture", "recording-close-cancel-and-confirm", "external-worker-remains-running");

  const crashedData = await saveConfig("桌面崩溃");
  const crashed = await launch(crashedData);
  const desktopPid = await crashed.application.evaluate(() => process.pid);
  // Kill the actual Electron main PID. Some Playwright versions expose a separate launch wrapper.
  process.kill(desktopPid, "SIGKILL");
  await noBackend(crashedData);
  checks.push("forced-desktop-exit-no-owned-backend");
  const lostData = await saveConfig("后台崩溃");
  const lost = await launch(lostData);
  const lostPid = Number((await readFile(join(lostData, "logs/desktop.log"), "utf8")).match(/backend ready pid=(\d+)/)[1]);
  // Only a PID just created and recorded by this isolated app, never a process-name match.
  process.kill(lostPid);
  await lost.page.getByRole("heading", { name: "启动或运行失败" }).waitFor();
  await lost.page.getByRole("button", { name: "退出应用" }).click();
  await until(() => !running.has(lost.application));
  checks.push("backend-crash-visible-error");
  if (installer) result.installerSha256 = hash(await readFile(installer));
  result.ok = true;
  await writeFile(join(work, "verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.ok = false; result.error = String(error);
  await writeFile(join(work, "verification.json"), JSON.stringify(result, null, 2));
  throw error;
} finally {
  for (const application of running) {
    try { await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }); await application.close(); } catch { application.process()?.kill(); }
  }
  if (receiver) { for (const socket of receiver.clients) socket.terminate(); receiver.close(); }
  if (ownsForeign) await new Promise((done) => foreign.close(done));
}
