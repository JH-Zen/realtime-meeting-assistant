import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

export interface BackendOptions {
  node: string;
  root: string;
  userData: string;
  onUnexpectedExit: (message: string) => void;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/** A handle to exactly one owned child, never a pid file or a process-name based stop command. */
export class ManagedBackend {
  readonly instanceId = randomUUID();
  readonly token = randomBytes(32).toString("hex");
  readonly logFile: string;
  child: ChildProcess | undefined;
  url = "";
  private stopping = false;
  private exited: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: BackendOptions) {
    mkdirSync(join(options.userData, "logs"), { recursive: true });
    this.logFile = join(options.userData, "logs", `backend-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  }

  async start(): Promise<string> {
    // Do not inherit developer API keys, NODE_OPTIONS, app config or Electron execution flags.
    const env: NodeJS.ProcessEnv = {};
    const systemKeys = /^(systemroot|windir|comspec|path|pathext|temp|tmp|userprofile|appdata|localappdata|homedrive|homepath|systemdrive|number_of_processors|processor_architecture)$/i;
    for (const [key, value] of Object.entries(process.env)) if (systemKeys.test(key)) env[key] = value;
    Object.assign(env, {
      RCC_CONFIG_FILE: join(this.options.userData, ".env"),
      RCC_DESKTOP_DATA_ROOT: this.options.userData,
      RCC_DESKTOP_INSTANCE: this.instanceId,
      RCC_DESKTOP_TOKEN: this.token,
      HOST: "127.0.0.1", PORT: "0",
      DB_PATH: join(this.options.userData, "data", "rcc.sqlite"),
      STATIC_DIR: join(this.options.root, "packages", "frontend", "dist"),
    });
    // Direct file handles survive parent loss. Piped logs could raise EPIPE during crash cleanup.
    const logFd = openSync(this.logFile, "a");
    let child: ChildProcess;
    try {
      child = fork(join(this.options.root, "packages", "backend", "dist", "index.js"), [], {
        execPath: this.options.node, execArgv: [], cwd: this.options.root, env,
        windowsHide: true, stdio: ["ignore", logFd, logFd, "ipc"],
      });
    } finally { closeSync(logFd); }
    this.child = child;
    this.exited = new Promise((done) => {
      child.once("exit", (code, signal) => {
        appendFileSync(this.logFile, `\n[desktop] backend exited code=${code} signal=${signal}\n`);
        done();
        if (this.url && !this.stopping) this.options.onUnexpectedExit(`后台意外退出（${code ?? signal}）。请退出应用后重新启动。`);
      });
      child.once("error", () => done());
    });
    try {
      const url = await new Promise<string>((done, fail) => {
        const timer = setTimeout(() => { cleanup(); fail(new Error("后台启动超时，未收到本实例的就绪通知。")); }, this.options.startupTimeoutMs ?? 30_000);
        const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", earlyExit); child.off("error", error); };
        const earlyExit = (code: number | null) => { cleanup(); fail(new Error(`后台启动失败（退出码 ${code}）。请查看后台日志。`)); };
        const error = (err: Error) => { cleanup(); fail(new Error(`无法启动配套 Node 运行时：${err.message}`)); };
        const message = (raw: unknown) => {
          if (!raw || typeof raw !== "object") return;
          const value = raw as Record<string, unknown>;
          if (value.type !== "rcc.ready" || value.instanceId !== this.instanceId || value.pid !== child.pid) return;
          if (typeof value.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url)) return;
          cleanup(); done(value.url);
        };
        child.on("message", message); child.once("exit", earlyExit); child.once("error", error);
      });
      // A successful /health alone is insufficient: it is checked only after an authenticated child IPC handshake.
      const response = await fetch(`${url}/health`, {
        headers: { "x-rcc-desktop": this.token }, signal: AbortSignal.timeout(3000),
      });
      const health = await response.json() as { ok?: boolean; instanceId?: string; pid?: number };
      if (!response.ok || !health.ok || health.instanceId !== this.instanceId || health.pid !== child.pid) {
        throw new Error("后台身份或就绪状态校验失败。");
      }
      if (child.exitCode !== null || this.stopping) throw new Error("启动已取消或后台已退出。");
      this.url = url;
      return url;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async state(): Promise<string> {
    const child = this.child;
    if (!child?.connected) return "unknown";
    const requestId = randomUUID();
    return new Promise((done) => {
      const timer = setTimeout(() => { child.off("message", receive); done("unknown"); }, 1000);
      const receive = (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const msg = raw as Record<string, unknown>;
        if (msg.type !== "rcc.status" || msg.instanceId !== this.instanceId || msg.requestId !== requestId) return;
        clearTimeout(timer); child.off("message", receive);
        done(typeof msg.state === "string" ? msg.state : "unknown");
      };
      child.on("message", receive);
      child.send({ type: "rcc.status", instanceId: this.instanceId, requestId }, () => undefined);
    });
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOwnedChild();
    return this.stopPromise;
  }

  private async stopOwnedChild(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: "rcc.shutdown", instanceId: this.instanceId }, () => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((done) => { timer = setTimeout(() => done("timeout"), this.options.shutdownTimeoutMs ?? 10_000); });
    const result = await Promise.race([this.exited, timeout]);
    clearTimeout(timer);
    if (result === "timeout" && child.exitCode === null && child.signalCode === null) {
      appendFileSync(this.logFile, "\n[desktop] graceful shutdown timed out; terminating owned child only\n");
      child.kill();
      await this.exited;
    }
  }
}
