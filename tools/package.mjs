/**
 * Staging builder for the Windows installer (ADR §6.5 D-36).
 *
 * The rule this file exists to enforce: **what gets packaged is what the gate tested.** So the runtime
 * dependency tree is not re-resolved from the registry — it is walked out of the `node_modules` already
 * on this machine, following Node's own resolution (nearest `node_modules` from the importing package,
 * then upward), and copied at the same relative position. That preserves the two nested copies npm
 * really made (`ajv/node_modules/fast-uri`), which a flatten-by-name install would silently break, and
 * it means a packaging run needs no network and executes no install script.
 *
 * Tiers (the user asked to be able to choose components rather than take one fixed bundle):
 *   core — backend + shared + the built page + `node.exe`. Full Mock functionality, no real model.
 *   m1   — `@huggingface/transformers` + onnxruntime, i.e. the real embedding runtime (~470 MB).
 *   m2   — the bge-m3 weights already cached under `models/embedding` (~659 MB).
 *   m3   — the sherpa-onnx model plus `requirements.txt` for the STT worker (~1.1 GB, needs Python).
 *
 * Usage: node tools/package.mjs --tier=core [--tier=m1 …] [--out=<dir>] [--keep]
 * `--keep` leaves an existing staging directory in place and only overwrites what it copies.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootModules = join(repo, "node_modules");
const backendDir = join(repo, "packages", "backend");

/** Direct dependencies the core tier must not carry: the whole real-embedding subtree hangs off these. */
const EMBEDDING_RUNTIME = ["@huggingface/transformers"];

const TIERS = {
  core: { label: "核心（Mock 全功能）", optional: false },
  m1: { label: "M1 真实 embedding 运行时", optional: true },
  m2: { label: "M2 bge-m3 权重", optional: true },
  m3: { label: "M3 sherpa-onnx 模型（需 Python）", optional: true },
};

/** Nearest package directory, the way Node would find it from `fromDir`. */
function locate(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `dest` is the path the directory must land at *inside* the staged `node_modules`, so a package npm put
 * under another package keeps that relationship. Anything found outside the root tree (a workspace's own
 * `node_modules`) is hoisted to the top, which is safe only because nothing else can see it — checked below.
 */
function destinationFor(source) {
  const rel = relative(rootModules, source);
  return rel.startsWith("..") ? null : rel;
}

async function packageJson(dir) {
  return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
}

/**
 * Walk the production closure of `seeds`. A required dependency that is not on disk is an error rather than
 * a skip, because the app would meet it as a module-not-found at the first click instead of during a build.
 * Optional peers are the exception and they are many — `openai` declares `undici` and three AWS packages that
 * way, `ws` declares `bufferutil`/`utf-8-validate` — and npm installed none of them, so a packaging run would
 * otherwise stop on six names the app never imports.
 *
 * Resolution is per importer, not from one shared directory, and that difference is not theoretical here:
 * `ajv` 8.20.0 resolves `fast-uri` to a nested **3.1.8** while the root copy is **4.2.2**. Resolving every
 * name from the seed directory would ship only 4.2.2 and silently change which version ajv loads — the exact
 * substitution this script exists to prevent, and what a flat `npm install --omit=dev` would also do.
 */
async function closure(seeds, { fromDir, prune = new Set(), required = true }) {
  const found = new Map();
  const queue = seeds.map((name) => ({ name, from: fromDir }));
  const missing = [];
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (prune.has(name)) continue;
    const source = locate(name, from);
    if (!source) {
      missing.push(name);
      continue;
    }
    const dest = destinationFor(source);
    if (dest === null && existsSync(join(rootModules, name))) {
      throw new Error(
        `${source} is a second copy of ${name} that would have to be hoisted over the root one — ` +
          "packaging would silently change which version the app loads",
      );
    }
    const key = dest ?? name;
    const previous = found.get(key);
    if (previous && previous !== source) throw new Error(`collision at ${key}: ${previous} vs ${source}`);
    if (previous) continue;
    found.set(key, source);
    for (const child of await reachableFrom(source)) queue.push({ name: child, from: source });
  }
  if (required && missing.length > 0) {
    throw new Error(`not installed: ${missing.join(", ")} — run npm install before packaging`);
  }
  return found;
}

/** The package names `dir` can actually reach at run time. */
async function reachableFrom(dir) {
  const pkg = await packageJson(dir);
  const names = [...Object.keys(pkg.dependencies ?? {})];
  for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
    const optional = pkg.peerDependenciesMeta?.[peer]?.optional === true;
    if (!optional || locate(peer, dir)) names.push(peer);
  }
  for (const soft of Object.keys(pkg.optionalDependencies ?? {})) {
    if (locate(soft, dir)) names.push(soft);
  }
  return names;
}

/** Files the runtime never reads: source maps and type declarations. Kept out of the installer on purpose. */
function isPayload(file) {
  return !file.endsWith(".map") && !file.endsWith(".d.ts");
}

async function copyPackage(dir, dest) {
  await cp(dir, dest, { recursive: true, filter: packageFilter(dir) });
}

/**
 * A package's own `node_modules` is left out here on purpose: every nested copy npm made is its own entry
 * in the closure map, so it lands at the same relative path by itself. Non-payload files go anywhere.
 */
function packageFilter(dir) {
  return (source) => {
    const rel = relative(dir, source).split(sep);
    if (rel[0] === "node_modules" || rel[0] === ".bin") return false;
    return isPayload(source);
  };
}

async function stageTree(tree, outDir) {
  for (const [rel, source] of [...tree].sort(([a], [b]) => a.localeCompare(b))) {
    await copyPackage(source, join(outDir, "node_modules", rel));
  }
  return tree.size;
}

async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      bytes += (await stat(path)).size;
      files += 1;
    }
  };
  await walk(dir);
  return { files, bytes };
}

const mebibytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

async function stageNode(outDir) {
  const dest = join(outDir, "runtime", "node.exe");
  if (!existsSync(dest)) {
    await mkdir(join(outDir, "runtime"), { recursive: true });
    await cp(process.execPath, dest);
  }
  const license = ["LICENSE", "LICENSE.md"]
    .map((name) => join(dirname(process.execPath), name))
    .find((path) => existsSync(path));
  if (!license) throw new Error("Node.js runtime LICENSE is missing beside node.exe; cannot redistribute it");
  await cp(license, join(outDir, "runtime", "LICENSE"));
  return dest;
}

async function stageCore(outDir) {
  const backendDeps = await packageJson(backendDir);
  const seeds = Object.keys(backendDeps.dependencies ?? {}).filter((name) => name !== "@rcc/shared");
  const tree = await closure(seeds, { fromDir: backendDir, prune: new Set(EMBEDDING_RUNTIME) });
  const count = await stageTree(tree, outDir);

  // `@rcc/shared` is a workspace symlink at development time; a shipped app cannot have symlinks in it,
  // so it becomes a real directory holding exactly what Node needs to resolve `import "@rcc/shared"`.
  const sharedDest = join(outDir, "node_modules", "@rcc", "shared");
  await mkdir(sharedDest, { recursive: true });
  await cp(join(repo, "packages", "shared", "package.json"), join(sharedDest, "package.json"));
  await cp(join(repo, "packages", "shared", "dist"), join(sharedDest, "dist"), {
    recursive: true,
    filter: (source) => isPayload(source),
  });

  await cp(join(backendDir, "package.json"), join(outDir, "packages", "backend", "package.json"));
  await cp(join(backendDir, "dist"), join(outDir, "packages", "backend", "dist"), {
    recursive: true,
    filter: (source) => isPayload(source),
  });
  await cp(join(repo, "packages", "frontend", "dist"), join(outDir, "packages", "frontend", "dist"), {
    recursive: true,
    filter: (source) => isPayload(source),
  });
  await cp(join(repo, "services"), join(outDir, "services"), {
    recursive: true,
    filter: (source) => !source.includes("__pycache__") && !source.endsWith(".pyc"),
  });
  await cp(join(repo, "docs"), join(outDir, "docs"), { recursive: true });
  await cp(join(repo, "README.md"), join(outDir, "README.md"));
  await cp(join(repo, "LICENSE"), join(outDir, "LICENSE"));

  // `.env.example` is the template; the install gets a real `.env` with the shipped defaults. No key is
  // ever written here — the one in this repo's own `.env` stays in this repo.
  const example = await readFile(join(repo, ".env.example"), "utf8");
  await writeFile(join(outDir, ".env.example"), example, "utf8");
  if (!existsSync(join(outDir, ".env"))) await writeFile(join(outDir, ".env"), example, "utf8");

  await mkdir(join(outDir, "var"), { recursive: true });
  await mkdir(join(outDir, "models"), { recursive: true });
  await stageNode(outDir);
  await writeLaunchers(outDir);
  return count;
}

/**
 * The launcher is deliberately a Node script rather than batch logic: it has to wait for `/health`, record
 * the child's pid so stopping is by-pid-only, and show a Chinese explanation when something is missing.
 */
async function writeLaunchers(outDir) {
  const start = `import { spawn } from "node:child_process";
import { openSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const entry = join(root, "packages", "backend", "dist", "index.js");
// --no-open exists so the shipped launcher can be driven by automated verification. Without it every test run
// puts a browser window on the desktop, which is the point of the launcher but not of the test.
const noOpen = process.argv.includes("--no-open");
if (!existsSync(entry)) {
  console.error("找不到 packages/backend/dist/index.js——这份安装不完整，请重新运行安装程序。");
  process.exit(1);
}
mkdirSync(join(root, "var"), { recursive: true });

// The backend takes its port from the process environment first and from .env second, and a launcher that
// assumes 8787 would probe and open the wrong address the moment someone edits .env. Same precedence here.
function configuredPort() {
  if (process.env.PORT && process.env.PORT.trim()) return process.env.PORT.trim();
  const file = join(root, ".env");
  if (!existsSync(file)) return "8787";
  for (const line of readFileSync(file, "utf8").split(/\\r?\\n/)) {
    const match = /^\\s*PORT\\s*=\\s*(.*)$/.exec(line);
    if (match && match[1].trim()) return match[1].trim();
  }
  return "8787";
}
const base = \`http://127.0.0.1:\${configuredPort()}\`;
const health = \`\${base}/health\`;

// A backend already answering means the app is up: open the page instead of starting a second one.
const alive = await fetch(health).then((response) => response.ok).catch(() => false);
if (alive) {
  console.log("实时认知助手已经在运行，直接打开页面。");
} else {
  const out = openSync(join(root, "var", "backend.log"), "a");
  const child = spawn(
    process.execPath,
    [entry],
    { cwd: root, windowsHide: true, detached: true, stdio: ["ignore", out, out] },
  );
  // Recorded so the stop script can kill exactly this process. Never kill by image name: it would take
  // out the user's own node processes along with ours.
  writeFileSync(join(root, "var", "backend.pid"), String(child.pid));
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const ready = await fetch(health).then((response) => response.ok).catch(() => false);
    if (ready) break;
  }
  console.log(\`实时认知助手已启动：\${base}/\`);
}
if (!noOpen) spawn("cmd.exe", ["/c", "start", "", \`\${base}/\`], { windowsHide: true, detached: true }).unref();
`;

  const stop = `import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const file = join(root, "var", "backend.pid");
if (!existsSync(file)) {
  console.log("没有记录在案的后台进程（var/backend.pid 不存在），不需要停止。");
  process.exit(0);
}
const pid = readFileSync(file, "utf8").trim();
if (!/^[0-9]+$/.test(pid)) {
  console.error("var/backend.pid 内容不是数字，没有执行任何终止操作。");
  process.exit(1);
}
const result = spawnSync("taskkill", ["/PID", pid, "/F"], { windowsHide: true, encoding: "utf8" });
console.log(result.status === 0 ? \`已停止后台进程 \${pid}。\` : \`taskkill 返回 \${result.status}：\${(result.stderr || "").trim()}\`);
rmSync(file, { force: true });
`;

  const bat = `@echo off
rem 实时认知助手 —— 启动后端并在浏览器里打开页面。关闭浏览器标签不会停掉后端，
rem 停止请用 RCC-stop.bat。
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%ROOT%bin\\RCC-start.mjs" %*
if errorlevel 1 pause
endlocal
`;

  const stopBat = `@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%ROOT%bin\\RCC-stop.mjs"
pause
endlocal
`;

  // The add-on menu reads the same function `/health` reads, through the shipped `dist`, so the two can never
  // disagree about whether a module is installed. It runs with the backend stopped on purpose: installing a
  // module is something you do when the app is not using it yet.
  const modules = `import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const dist = join(root, "packages", "backend", "dist");
const probeFile = join(dist, "observability", "modules.js");
const configFile = join(dist, "config", "env.js");
if (!existsSync(probeFile) || !existsSync(configFile)) {
  console.error("找不到 packages/backend/dist 里的模块检查代码——这份安装不完整，请重新运行安装程序。");
  process.exit(1);
}
const { deriveModules } = await import(pathToFileURL(probeFile).href);
const { loadConfig } = await import(pathToFileURL(configFile).href);
const settings = loadConfig(root);
const modules = deriveModules({
  root,
  embeddingModelDir: settings.embedding.modelDir,
  embeddingModel: settings.embedding.model,
});

console.log("实时认知助手 —— 可选模块状态");
console.log("安装目录：" + root);
console.log("");
for (const item of modules) {
  console.log("[" + (item.installed ? "已装" : "未装") + "] " + item.label);
  if (!item.installed) {
    console.log("      检查过：" + item.checked.join("、"));
    console.log("      怎么装：" + item.remedy);
  }
  console.log("");
}
const ready = modules.filter((item) => item.installed).map((item) => item.id);
if (ready.includes("m1") && ready.includes("m2") && settings.embedding.mock) {
  console.log("M1 与 M2 都已就位，但 .env 里 MOCK_EMBEDDING 仍是 true——现在用的是 Mock 检索。改成 false 并重启即可用上真实嵌入。");
}
console.log("说明：真实检索要 M1 与 M2 同时到位，并把 .env 的 MOCK_EMBEDDING 设为 false；");
console.log("      M3 只是模型文件，录音还要另开一个终端启动 worker（上面 M3 的“怎么装”一行有完整命令）；");
console.log("      装好任何模块后重新运行 RCC.bat 才会生效。");
`;

  const modulesBat = `@echo off
rem 查看可选模块（M1 真实 embedding 运行时 / M2 模型权重 / M3 sherpa 语音模型）的安装状态与加装方法。
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%ROOT%bin\\RCC-modules.mjs" %*
pause
endlocal
`;

  await mkdir(join(outDir, "bin"), { recursive: true });
  await writeFile(join(outDir, "bin", "RCC-start.mjs"), start, "utf8");
  await writeFile(join(outDir, "bin", "RCC-stop.mjs"), stop, "utf8");
  await writeFile(join(outDir, "bin", "RCC-modules.mjs"), modules, "utf8");
  await writeFile(join(outDir, "RCC.bat"), bat, "utf8");
  await writeFile(join(outDir, "RCC-stop.bat"), stopBat, "utf8");
  await writeFile(join(outDir, "RCC-modules.bat"), modulesBat, "utf8");
}

async function stageModule(tier, outDir) {
  if (tier === "m1") {
    const tree = await closure(EMBEDDING_RUNTIME, { fromDir: backendDir });
    return stageTree(tree, outDir);
  }
  if (tier === "m2") {
    const source = join(repo, "models", "embedding");
    if (!existsSync(source)) throw new Error(`${source} 不存在：M2 需要先有一次真实 embedding 运行把权重落到本地`);
    await cp(source, join(outDir, "models", "embedding"), { recursive: true });
    return 1;
  }
  if (tier === "m3") {
    const source = resolve(sttModelSource());
    if (!isSherpaModelDir(source)) {
      throw new Error(`${source} 不是一个可用的 sherpa 模型目录（需要 tokens.txt 加 encoder/decoder/joiner 或单个 model*.onnx）`);
    }
    // The model directory itself is what the worker is pointed at, so it keeps its own name inside `models/stt`:
    // a fixed rename would make the command `RCC-modules.bat` prints wrong for the model actually shipped.
    const dest = join(outDir, "models", "stt", basename(source));
    await cp(source, dest, { recursive: true });
    await cp(join(repo, "services", "stt-worker", "requirements.txt"), join(dest, "requirements.txt"));
    return 1;
  }
  throw new Error(`unknown module tier ${tier}`);
}

/**
 * `--m3-source=<dir>`, else the first directory on this machine that holds a usable model. A *cache* directory
 * is not a model directory: `.probe-model` also holds the `.tar.bz2` downloads and the probe scripts that
 * produced the measurement, and packaging that whole tree would ship ~530 MB of things the app cannot read.
 */
function sttModelSource() {
  const flag = process.argv.find((arg) => arg.startsWith("--m3-source="))?.slice("--m3-source=".length);
  if (flag) return flag;
  const roots = [join(repo, ".probe-model"), "D:/sherpa-model"].filter((dir) => existsSync(dir));
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      const candidate = join(root, name);
      if (isSherpaModelDir(candidate)) return candidate;
    }
  }
  return join(repo, ".probe-model");
}

const ONNX_SUFFIX = /\.onnx$/i;

/**
 * The same rule `deriveModules` uses to call a directory an installed M3 (`packages/backend/src/observability
 * /modules.ts`, mirrored here because this file must run before any build product exists). Both follow
 * `stt_worker.py`'s `validate_model_paths`, which is the only version of "usable" that matters.
 */
function isSherpaModelDir(dir) {
  if (!existsSync(join(dir, "tokens.txt"))) return false;
  const names = readdirSync(dir);
  const transducer = ["encoder", "decoder", "joiner"].every((part) =>
    names.some((name) => name.startsWith(part) && ONNX_SUFFIX.test(name)),
  );
  return transducer || names.some((name) => name.startsWith("model") && ONNX_SUFFIX.test(name));
}

async function main() {
  const args = process.argv.slice(2);
  const requested = args
    .filter((arg) => arg.startsWith("--tier="))
    .flatMap((arg) => arg.slice("--tier=".length).split(","));
  const tiers = requested.filter((tier) => tier in TIERS);
  const unknown = requested.filter((tier) => !(tier in TIERS));
  if (tiers.length === 0) {
    console.error(
      "用法：node tools/package.mjs --tier=core[,m1,m2,m3] [--out=<dir>] [--keep]" +
        (unknown.length > 0 ? `\n未知档位：${unknown.join(", ")}（可选：${Object.keys(TIERS).join(", ")}）` : ""),
    );
    process.exit(2);
  }
  const outOverride = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
  const keep = args.includes("--keep");

  // Core is the only tier that copies build products, so it is the only one that can silently ship a stale dist.
  if (tiers.includes("core")) assertBuildProducts();

  for (const tier of tiers) {
    const outDir = outDirFor(tier, outOverride);
    if (existsSync(outDir)) {
      if (keep) console.log(`--keep：在既有 ${outDir} 上覆盖写入`);
      else await rm(outDir, { recursive: true, force: true });
    }
    await mkdir(outDir, { recursive: true });
    console.log(`\n=== ${TIERS[tier].label} (${tier}) → ${outDir} ===`);
    if (tier === "core") {
      const packages = await stageCore(outDir);
      console.log(`运行时依赖闭包 ${packages} 个包（已剥掉 ${EMBEDDING_RUNTIME.join(", ")} 与其整棵子树）`);
    } else {
      console.log(`模块条目 ${await stageModule(tier, outDir)} 项`);
    }
    const size = await dirStats(outDir);
    console.log(`产物：${size.files} 个文件，${mebibytes(size.bytes)}`);
  }
}

/** Everything stageCore copies blindly. A missing one of these packages a broken app with a green exit code. */
function assertBuildProducts() {
  const required = [
    join(backendDir, "dist", "index.js"),
    join(repo, "packages", "frontend", "dist", "index.html"),
    // The trap this repo already paid for: the backend imports shared's *dist*, its unit tests import *src*.
    join(repo, "packages", "shared", "dist", "index.js"),
  ];
  for (const file of required) {
    if (!existsSync(file)) throw new Error(`${file} 不存在：先跑 npm run build（改过 packages/shared/src 还要 npm run build -w @rcc/shared）`);
  }
}

function outDirFor(tier, outOverride) {
  return resolve(outOverride ? join(outOverride, tier) : join(repo, ".scratch", "pkg", tier));
}

await main().catch((error) => {
  console.error(`打包失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
