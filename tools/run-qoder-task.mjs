import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const QODER_MODEL_ID = "DeepSeek-Flash";
export const QODER_MODEL_NAME = "DeepSeek-Flash";

/** Run only in an explicit task copy, with file tools and no shell/network/MCP tools. */
export function taskArguments(taskDir, prompt) {
  return ["--cwd", taskDir, "--model", QODER_MODEL_ID,
    "--tools", "Read", "Edit", "Write", "Glob", "Grep",
    "--allowed-tools", "Read,Edit,Write,Glob,Grep", "--permission-mode", "accept_edits",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--max-output-tokens", "8192", "--max-model-request-retries", "1",
    "--no-session-persistence", "--output-format", "stream-json", "--print", prompt];
}

async function main() {
  const taskArg = process.argv.slice(2).find((arg) => arg.startsWith("--task-dir="));
  if (!taskArg) throw new Error("用法：node tools/run-qoder-task.mjs --task-dir=<独立任务副本目录>");
  const taskDir = resolve(taskArg.slice("--task-dir=".length));
  const manifest = JSON.parse(readFileSync(join(taskDir, "task-manifest.json"), "utf8"));
  if (!manifest.taskId || !Array.isArray(manifest.writable) || manifest.writable.length === 0) {
    throw new Error("任务副本缺少 taskId / writable 清单");
  }
  if (existsSync(join(taskDir, ".git")) || existsSync(join(taskDir, ".env"))) {
    throw new Error("请使用独立源码任务副本，不在带 .git 或 .env 的目录中运行");
  }
  const cli = join(process.env.USERPROFILE ?? "", ".qoder", "bin", "qodercli", "qodercli.exe");
  if (!existsSync(cli)) throw new Error(`未找到 Qoder CLI：${cli}`);
  const prompt = readFileSync(join(taskDir, "TASK.md"), "utf8");
  const started = Date.now();
  const args = taskArguments(taskDir, prompt);
  const eventLog = join(taskDir, "qoder-events.jsonl");
  writeFileSync(eventLog, "");
  const child = spawn(cli, args, { cwd: taskDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  // A deadline affects this invocation only. File tools cannot create shell children.
  const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 8 * 60 * 1000);
  child.stdout.on("data", (chunk) => { stdout += chunk; appendFileSync(eventLog, chunk); });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); }).finally(() => clearTimeout(deadline));
  writeFileSync(join(taskDir, "qoder-events.jsonl"), stdout);
  writeFileSync(join(taskDir, "qoder-stderr.log"), stderr);
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.findLast((event) => event.type === "result");
  const report = { taskId: manifest.taskId, model: QODER_MODEL_NAME, requestedModelId: QODER_MODEL_ID,
    exitCode: code, timedOut, durationMs: Date.now() - started, eventCount: events.length,
    modelUsageIds: Object.keys(result?.modelUsage ?? {}), isError: result?.is_error ?? null,
    permissionDenials: (result?.permission_denials ?? []).map((denial) => ({ tool: denial.tool_name, reason: denial.message })), result: result?.result ?? "", stderr: stderr.slice(-2000) };
  writeFileSync(join(taskDir, "qoder-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (code !== 0 || timedOut || !result || result.is_error || report.permissionDenials.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
