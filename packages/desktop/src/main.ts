import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ManagedBackend } from "./backend.js";

app.setName("实时会议助手（桌面预览）");
app.setAppUserModelId("org.rcc.desktop.preview");
const appVersion = app.getVersion();
const dev = !app.isPackaged;
const userData = resolve(process.env.RCC_DESKTOP_USER_DATA ?? join(app.getPath("appData"), "..", "Local", dev ? "RCC-Desktop-Dev" : "RCC-Desktop-Preview"));
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.setPath("sessionData", join(userData, "chromium"));
// No instance may create a backend until it owns Electron's OS-level instance lock.
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.exit(0);

const root = dev ? resolve(__dirname, "../../..") : join(process.resourcesPath, "backend");
const node = dev ? process.env.RCC_DESKTOP_NODE : join(root, "runtime", "node.exe");
const statusPath = resolve(__dirname, "../assets/status.html");
const statusUrl = pathToFileURL(statusPath).href;
mkdirSync(join(userData, "logs"), { recursive: true });
const desktopLog = join(userData, "logs", "desktop.log");
if (existsSync(desktopLog) && statSync(desktopLog).size > 2 * 1024 * 1024) renameSync(desktopLog, `${desktopLog}.previous`);
const log = (message: string) => appendFileSync(desktopLog, `${new Date().toISOString()} ${message}\n`);
let win: BrowserWindow | undefined;
let backend: ManagedBackend | undefined;
let quitting = false;
let closed = false;
let closePrompt = false;
let activeCapture = false;
let microphoneAllowed = false;
let status = { kind: "loading", message: "正在启动本地后台，请稍候…", logPath: join(userData, "logs") };

function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
  const url = event.senderFrame.url;
  return url === statusUrl || (!!backend?.url && url === `${backend.url}/`);
}

async function showStatus(kind: string, message: string): Promise<void> {
  status = { kind, message, logPath: join(userData, "logs") };
  if (!win || win.isDestroyed()) return;
  if (win.webContents.getURL() !== statusUrl) await win.loadFile(statusPath);
  win.webContents.send("desktop:status", status);
}

function activate(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function releaseRenderer(): Promise<void> {
  const window = win;
  if (!window || window.isDestroyed()) return;
  if (window.webContents.getURL() === `${backend?.url}/`) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { ipcMain.off("desktop:prepared", ack); done(); }, 1500);
      const ack = (event: Electron.IpcMainEvent) => {
        if (!trusted(event)) return;
        clearTimeout(timer); ipcMain.off("desktop:prepared", ack); done();
      };
      ipcMain.on("desktop:prepared", ack);
      window.webContents.send("desktop:prepare-quit");
    });
  }
  // Navigation destroys the capture document even if its JS is unresponsive or didn't acknowledge.
  await showStatus("loading", "正在停止采集、保存会话并关闭后台…");
}

async function requestExit(): Promise<void> {
  if (quitting || closePrompt) return;
  closePrompt = true;
  try {
    const state = backend?.url ? await backend.state() : "idle";
    if (activeCapture || state === "recording" || state === "paused" || (state === "unknown" && backend?.child?.exitCode === null)) {
      const result = await dialog.showMessageBox(win as BrowserWindow, {
        type: "question", title: "结束记录并退出？", message: "当前仍在录音、暂停或等待采集。",
        detail: "退出将停止麦克风和后台，并保存已收到的会话内容。尚未完成的模型任务可能无法保存。",
        buttons: ["继续使用", "结束并退出"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) return;
    }
    quitting = true;
    log("exit requested");
    try { await releaseRenderer(); } catch (error) { log(`renderer cleanup: ${String(error)}`); win?.destroy(); }
    await backend?.stop();
    closed = true;
    win?.destroy();
    log("desktop cleanup complete");
    app.quit();
  } catch (error) {
    log(`exit failed: ${String(error)}`);
    // stop() only addresses our child; dropping IPC also tells it that the desktop has gone away.
    await backend?.stop();
    closed = true;
    win?.destroy();
    app.exit(1);
  } finally { closePrompt = false; }
}

async function start(): Promise<void> {
  mkdirSync(join(userData, "data"), { recursive: true });
  const configFile = join(userData, ".env");
  if (!existsSync(configFile)) copyFileSync(join(root, ".env.example"), configFile, constants.COPYFILE_EXCL);
  const isolated = session.fromPartition("desktop");
  // Only this window's verified backend and the bundled loading/error page may supply content.
  const localAssets = new Set(["status.html", "status.js"].map((file) => pathToFileURL(resolve(__dirname, "../assets", file)).href));
  const ownedOrigin = (url: string) => {
    try { const parsed = new URL(url); return !!backend?.url && (parsed.origin === backend.url || parsed.origin === backend.url.replace("http:", "ws:")); }
    catch { return false; }
  };
  isolated.webRequest.onBeforeRequest((details, done) => {
    const allowed = localAssets.has(details.url) || ownedOrigin(details.url) || (!!backend?.url && details.url.startsWith(`blob:${backend.url}/`));
    done({ cancel: !allowed });
  });
  isolated.webRequest.onBeforeSendHeaders((details, done) => {
    const headers = details.requestHeaders;
    if (ownedOrigin(details.url) && backend) headers["x-rcc-desktop"] = backend.token;
    done({ requestHeaders: headers });
  });
  const trustedMedia = (contents: Electron.WebContents | null, origin: string) =>
    contents === win?.webContents && !!backend?.url && origin === backend.url && !quitting;
  isolated.setPermissionCheckHandler((contents, permission, origin, details) =>
    permission === "media" && details.mediaType === "audio" && microphoneAllowed && trustedMedia(contents, origin));
  isolated.setPermissionRequestHandler((contents, permission, done, details) => {
    let origin = "";
    try { origin = new URL(details.requestingUrl).origin; } catch { /* invalid origins are refused */ }
    log(`permission request=${permission} origin=${origin} mainFrame=${details.isMainFrame} media=${"mediaTypes" in details ? details.mediaTypes?.join(",") : "none"}`);
    if (permission !== "media" || !trustedMedia(contents, origin) || !details.isMainFrame ||
      !("mediaTypes" in details) || !details.mediaTypes?.length || details.mediaTypes.some((type) => type !== "audio")) { done(false); return; }
    void dialog.showMessageBox(win as BrowserWindow, {
      type: "question", title: "麦克风权限", message: "允许实时会议助手使用麦克风？",
      detail: "仅在你开始录音时采集。暂停、结束或退出会释放设备；Windows 的设备权限仍然生效。",
      buttons: ["允许麦克风", "拒绝"], defaultId: 1, cancelId: 1, noLink: true,
    }).then((result) => { microphoneAllowed = result.response === 0 && !quitting; done(microphoneAllowed); }).catch(() => done(false));
  });
  isolated.setDevicePermissionHandler(() => false);
  isolated.setDisplayMediaRequestHandler((_request, done) => done({}));
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 640, show: false,
    title: `实时会议助手（桌面预览） v${appVersion}`, backgroundColor: "#111827",
    webPreferences: {
      session: isolated, preload: join(__dirname, "preload.js"),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) => {
    log(`renderer gone: ${details.reason}`);
    if (!quitting) void backend?.stop().then(() => showStatus("error", "页面进程已停止，后台正在退出。请关闭应用后重新启动。"));
  });
  win.on("close", (event) => { if (!closed) { event.preventDefault(); void requestExit(); } });
  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("ready-to-show", () => activate());
  await win.loadFile(statusPath);
  activate();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "应用", submenu: [
      { label: "打开用户数据文件夹", click: () => { void shell.openPath(userData); } },
      { label: "打开日志文件夹", click: () => { void shell.openPath(join(userData, "logs")); } },
      { type: "separator" }, { label: "退出", accelerator: "Alt+F4", click: () => { void requestExit(); } },
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, ...(dev ? [{ role: "toggleDevTools" as const }] : [])] },
    { label: "帮助", submenu: [{ id: "about-rcc", label: "关于实时会议助手", click: () => {
      if (win) void dialog.showMessageBox(win, { type: "info", title: "关于实时会议助手", message: "实时会议助手（桌面预览）", detail: `版本 ${appVersion}\n本机会议记录、导图与问答。`, buttons: ["确定"] });
    } }] },
  ]));
  if (!node || !existsSync(node)) throw new Error("找不到配套的 Node 运行时。请重新安装，开发时请使用 npm run dev:desktop。");
  backend = new ManagedBackend({ node, root, userData, onUnexpectedExit: (message) => {
    log(message); activeCapture = false; void showStatus("error", message);
  } });
  log(`starting backend; log=${backend.logFile}`);
  const url = await backend.start();
  log(`backend ready pid=${backend.child?.pid} instance=${backend.instanceId} url=${url}`);
  if (quitting) { await backend.stop(); return; }
  const page = await fetch(`${url}/`, { headers: { "x-rcc-desktop": backend.token }, signal: AbortSignal.timeout(3000) });
  if (!page.ok || !(await page.text()).includes('id="root"')) throw new Error("后台已就绪，但找不到构建后的业务页面。请重新构建或安装。");
  await win.loadURL(`${url}/`);
  log("business page loaded");
}

if (ownsLock) {
  app.on("second-instance", () => { log("second instance: activating existing window"); activate(); });
  app.on("activate", activate);
  app.on("before-quit", (event) => { if (!closed) { event.preventDefault(); void requestExit(); } });
  app.on("window-all-closed", () => { if (closed) app.quit(); else void requestExit(); });
  ipcMain.handle("desktop:startup-state", (event) => trusted(event) ? status : null);
  ipcMain.handle("desktop:open-logs", (event) => trusted(event) ? shell.openPath(join(userData, "logs")) : undefined);
  ipcMain.on("desktop:capture-active", (event, value: unknown) => { if (trusted(event) && typeof value === "boolean") activeCapture = value; });
  ipcMain.on("desktop:exit", (event) => { if (trusted(event)) void requestExit(); });
  app.whenReady().then(start).catch(async (error: unknown) => {
    log(`startup failed: ${String(error)}`);
    await backend?.stop();
    if (quitting) return;
    if (win && !win.isDestroyed()) await showStatus("error", error instanceof Error ? error.message : String(error));
    else {
      dialog.showErrorBox("实时会议助手启动失败", `${String(error)}\n日志：${desktopLog}`);
      closed = true; app.exit(1);
    }
  });
}
