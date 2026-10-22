/**
 * Turns a staged directory into a single `Setup.exe`. (ADR §6.5 D-36.)
 *
 * The agreed shape was an IExpress self-extracting package, and IExpress is broken on this machine: it starts
 * `makecab.exe`, `makecab` succeeds when called by hand, but the intermediate cabinet is never created, so every
 * build stops at `Unable to open the Cabinet file '<dir>\~<name>.CAB'` and the only thing on disk is the 172 032-byte
 * stub. Measured across eight SED shapes, `/N`, `/N /Q`, `/N /A /Q`, bare, `InsideCompressed` 0/1, `InstallApp`
 * and `RestoreFiles`, cwd Chinese vs ASCII, and TEMP redirected to ASCII — all identical. `.sed` handling is not
 * the problem, so this script builds the same deliverable with the compiler that is already in Windows instead:
 * `csc.exe` in `Microsoft.NET\Framework64`, embedding `tools/installer/Setup.cs` plus `payload.zip`.
 *
 * Two things fall out of that switch, both improvements:
 *   · No ASCII-only strings any more. The user-visible Chinese lives in a UTF-8 manifest resource, so a Chinese
 *     install directory and a Chinese label are simply allowed.
 *   · The payload is read by .NET's own zip code, so the *installed machine* needs neither bsdtar nor a wizard.
 *
 * IExpress is still what a user would see if they opened the produced exe in an editor: nothing. It is a normal
 * console/WinForms assembly, unsigned, so SmartScreen will warn on a first run. That is a signing question, not a
 * packaging one, and is recorded as OPEN rather than worked around here.
 *
 * Usage: node tools/make-installer.mjs --staged=<dir> --name=<RCC-Core> [--label=..] [--required=..]
 *        [--launcher=..] [--out=<dir>] [--build=<dir>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const staged = resolve(arg("staged", join(repo, ".scratch", "pkg", "core")));
const name = arg("name", "RCC-Core");
const build = resolve(arg("build", join(repo, ".scratch", "pkg", "build")));
const out = resolve(arg("out", join(build, "out")));
const label = arg("label", "实时辅助记录（Real-time Cognitive Companion）核心包 · Mock 全功能");
// Which file proves the extraction was complete, and what the user double-clicks afterwards. Both are per tier:
// a module package has neither a backend dist nor its own launcher.
const required = arg("required", join("packages", "backend", "dist", "index.js"));
const launcher = arg("launcher", "RCC.bat");

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const tar = join(systemRoot, "System32", "tar.exe");
const compiler = join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!existsSync(tar)) fail(`${tar} 不存在——这台机器没有 System32 的 tar。`);
if (!existsSync(compiler)) fail(`${compiler} 不存在——这台机器没有 .NET Framework 4 的 csc，无法产出 Setup.exe。`);
// Three different staged trees are legitimate: core (has its own runtime), m1 (only `node_modules`), and a
// module of weights (`models`). Anything else is a directory this script was not pointed at by accident.
if (!existsSync(join(staged, "runtime", "node.exe")) && !existsSync(join(staged, "models")) && !existsSync(join(staged, "node_modules"))) {
  console.error(`${staged} 看起来不是 tools/package.mjs 产出来的暂存目录（既没有 runtime/node.exe，也没有 models/，也没有 node_modules/）`);
  process.exit(1);
}

const work = join(build, name);
assertDisjoint(work, staged);
rmSync(work, { recursive: true, force: true });
rmSync(join(out, `${name}-Setup.exe`), { force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

const mebibytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

// ── 1. payload ────────────────────────────────────────────────────────────────────────────────────
const payload = join(work, "payload.zip");
console.log(`压包 ${staged} → ${payload}`);
const zipped = run(tar, ["-a", "-c", "-f", payload, "-C", staged, "."]);
if (zipped.status !== 0) fail(`tar 压包失败：${zipped.stderr.slice(0, 600)}`);
console.log(`payload.zip = ${mebibytes(statSync(payload).size)}`);

// ── 2. manifest + compile ─────────────────────────────────────────────────────────────────────────
const manifest = join(work, "rcc-manifest.txt");
writeFileSync(
  manifest,
  [`label=${label}`, `required=${required}`, `launcher=${launcher}`, ""].join("\n"),
  "utf8",
);

const setupExe = join(out, `${name}-Setup.exe`);
const frameworkDir = dirname(compiler);
const cscArgs = [
  "/nologo",
  "/target:exe",
  `/out:${setupExe}`,
  `/resource:${payload},payload.zip`,
  `/resource:${manifest},rcc-manifest.txt`,
  `/lib:${frameworkDir}`,
  "/reference:System.Windows.Forms.dll",
  `/reference:${fromGac("System.IO.Compression.dll")}`,
  `/reference:${fromGac("System.IO.Compression.FileSystem.dll")}`,
  join(repo, "tools", "installer", "Setup.cs"),
];
console.log(`编译 ${setupExe}`);
const compiled = run(compiler, cscArgs);
if (compiled.stdout) console.log(compiled.stdout.trim());
if (compiled.status !== 0) fail(`csc 退出 ${compiled.status}：${compiled.stderr.slice(0, 800)}`);
if (!existsSync(setupExe)) fail("csc 退出 0 但没有产出 exe");

console.log(`\n产物：${setupExe}\n      ${mebibytes(statSync(setupExe).size)}`);
console.log("下一步：node .scratch/run-setup-exe.mjs '<这个 exe>' '<目标目录>' 会真装一遍，再启动装出来的应用。");

/**
 * Measured, not hypothetical: a probe passed `--build=D:\rcc-build` with `--staged=D:\rcc-build\mini` and the
 * default name, and `work` became `D:\rcc-build\MINI` — the same directory as `staged`, because Windows paths
 * are case-insensitive. `tar` then archived the `payload.zip` it was writing, so the package contained one
 * 0-byte entry, exited 0, and only the post-install check caught it. A build that overlaps the tree it is
 * packing is refused here instead of producing a silently empty installer, and the check runs before anything
 * is deleted, because the cleanup below would otherwise remove the tree it is guarding.
 */
function assertDisjoint(workDir, stagedDir) {
  const inside = relative(resolve(stagedDir).toLowerCase(), resolve(workDir).toLowerCase());
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    fail(
      `构建工作目录 ${workDir} 与暂存目录 ${stagedDir} 重叠（Windows 路径大小写不敏感）。` +
        "tar 会把正在写的 payload.zip 打进包里，产出一个看似成功、实则为空的安装包。换一个 --build。",
    );
  }
}

/** The two zip assemblies are not in the Framework directory the way `System.Windows.Forms.dll` is. */
function fromGac(dll) {
  const gac = join(systemRoot, "Microsoft.NET", "assembly", "GAC_MSIL", dll.replace(/\.dll$/, ""));
  if (existsSync(gac)) {
    const versions = readdirSync(gac).sort();
    for (const version of versions) {
      const candidate = join(gac, version, dll);
      if (existsSync(candidate)) return candidate;
    }
  }
  const direct = join(dirname(compiler), dll);
  if (existsSync(direct)) return direct;
  fail(`找不到 ${dll}：.NET Framework 4.5 以上的压缩程序集不在这台机器上，装包壳无法编译。`);
}

function run(exe, args) {
  const r = spawnSync(exe, args, { encoding: "buffer", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${exe} 启动失败：${r.error.code ?? r.error.message}`);
  return { status: r.status, stdout: dec(r.stdout), stderr: dec(r.stderr) };
}

/** cmd's output on this box is codepage 936; reading it as UTF-8 would turn any Chinese path into mojibake. */
function dec(bytes) {
  if (!bytes) return "";
  try {
    return new TextDecoder("gbk").decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function fail(message) {
  console.error(`打包失败：${message}`);
  process.exit(1);
}
