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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDesktopVersion, stagedDesktopVersion, validateDesktopVersion } from "./desktop-version.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const desktop = argv.includes("--desktop");
const arg = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const staged = resolve(arg("staged", join(repo, ".scratch", "pkg", desktop ? "desktop" : "core")));
const version = desktop ? stagedDesktopVersion(staged) : validateDesktopVersion(arg("version", readDesktopVersion())).version;
const name = arg("name", desktop ? `RCC-Desktop-Preview-${version}` : "RCC-Core");
if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") fail("安装包名称只能使用字母、数字、连字符、点和下划线，不能是目录跳转。");
const build = resolve(arg("build", join(repo, ".scratch", "pkg", "build")));
const out = resolve(arg("out", desktop ? join(repo, "outputs", "desktop-preview", `v${version}`) : join(build, "out")));
const label = arg("label", desktop ? "实时会议助手（桌面预览）" : "实时辅助记录（Real-time Cognitive Companion）核心包 · Mock 全功能");
// Which file proves the extraction was complete, and what the user double-clicks afterwards. Both are per tier:
// a module package has neither a backend dist nor its own launcher.
const required = arg("required", desktop ? "实时会议助手.exe" : join("packages", "backend", "dist", "index.js"));
const launcher = arg("launcher", desktop ? "实时会议助手.exe" : "RCC.bat");
if ([label, required, launcher, arg("shortcut", "")].some((value) => /[\r\n]/.test(value))) fail("安装元数据不能包含换行。");
if (/[<>:"/\\|?*]/.test(arg("shortcut", ""))) fail("快捷方式名称不能包含路径或 Windows 文件名禁用字符。");

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const tar = join(systemRoot, "System32", "tar.exe");
const compiler = join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!existsSync(tar)) fail(`${tar} 不存在——这台机器没有 System32 的 tar。`);
if (!existsSync(compiler)) fail(`${compiler} 不存在——这台机器没有 .NET Framework 4 的 csc，无法产出 Setup.exe。`);
// Three different staged trees are legitimate: core (has its own runtime), m1 (only `node_modules`), and a
// module of weights (`models`). Anything else is a directory this script was not pointed at by accident.
if (!existsSync(join(staged, "runtime", "node.exe")) && !existsSync(join(staged, "resources", "backend", "runtime", "node.exe")) && !existsSync(join(staged, "models")) && !existsSync(join(staged, "node_modules"))) {
  console.error(`${staged} 看起来不是 tools/package.mjs 产出来的暂存目录（既没有 runtime/node.exe，也没有 models/，也没有 node_modules/）`);
  process.exit(1);
}

const work = join(build, name);
const setupExe = join(out, `${name}-Setup.exe`);
if (existsSync(setupExe) && !argv.includes("--replace")) fail("此版本已有安装包。请先更新版本号；只有替换尚未交付的本地构建时才显式使用 --replace。");
if (dirname(work).toLowerCase() !== build.toLowerCase()) fail("构建工作目录必须位于指定 build 目录中。");
for (const protectedDir of [repo, ...["packages", "services", "docs", "tools", "design"].map((item) => join(repo, item))]) {
  const below = relative(protectedDir.toLowerCase(), work.toLowerCase());
  const above = relative(work.toLowerCase(), protectedDir.toLowerCase());
  const inside = (path) => path === "" || (!path.startsWith("..") && !isAbsolute(path));
  if (inside(above) || (protectedDir !== repo && inside(below))) fail(`拒绝清理源码目录：${work}`);
}
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
if (zipped.status !== 0) {
  // Some Windows Server images crash inside their bundled bsdtar while creating this archive.
  // Recreate only our validated build payload with the same .NET ZIP reader/writer used by Setup.
  console.warn(`System32 tar 压包退出 ${zipped.status}，改用 .NET ZIP：${zipped.stderr.slice(0, 600)}`);
  rmSync(payload, { force: true });
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(staged)}, ${quote(payload)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`;
  const fallback = run(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  if (fallback.status !== 0 || !existsSync(payload)) fail(`.NET ZIP 压包失败（${fallback.status}）：${fallback.stderr.slice(0, 600)}`);
}
console.log(`payload.zip = ${mebibytes(statSync(payload).size)}`);

// ── 2. manifest + compile ─────────────────────────────────────────────────────────────────────────
const manifest = join(work, "rcc-manifest.txt");
writeFileSync(
  manifest,
  [`label=${label}`, `version=${version}`, `required=${required}`, `launcher=${launcher}`, `shortcut=${arg("shortcut", desktop ? "实时会议助手（桌面预览）" : "")}`, `defaultFolder=${desktop ? "RCC-Desktop-Preview" : "RCC"}`, ""].join("\n"),
  "utf8",
);

const frameworkDir = dirname(compiler);
const assemblyInfo = join(work, "AssemblyInfo.cs");
writeFileSync(assemblyInfo, `using System.Reflection;\n[assembly: AssemblyTitle("实时会议助手安装向导")]\n[assembly: AssemblyProduct("实时会议助手")]\n[assembly: AssemblyVersion("${validateDesktopVersion(version).windowsVersion}")]\n[assembly: AssemblyFileVersion("${validateDesktopVersion(version).windowsVersion}")]\n[assembly: AssemblyInformationalVersion("${version}")]\n`, "utf8");
const cscArgs = [
  "/nologo",
  "/codepage:65001",
  "/target:winexe",
  `/win32manifest:${join(repo, "tools", "installer", "app.manifest")}`,
  `/out:${setupExe}`,
  `/resource:${payload},payload.zip`,
  `/resource:${manifest},rcc-manifest.txt`,
  `/lib:${frameworkDir}`,
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  `/reference:${fromGac("System.IO.Compression.dll")}`,
  `/reference:${fromGac("System.IO.Compression.FileSystem.dll")}`,
  join(repo, "tools", "installer", "Setup.cs"),
  join(repo, "tools", "installer", "Installer.cs"),
  join(repo, "tools", "installer", "InstallerWizard.cs"),
  assemblyInfo,
];
console.log(`编译 ${setupExe}`);
const compiled = run(compiler, cscArgs);
if (compiled.stdout) console.log(compiled.stdout.trim());
if (compiled.status !== 0) fail(`csc 退出 ${compiled.status}：${compiled.stderr.slice(0, 800)}`);
if (!existsSync(setupExe)) fail("csc 退出 0 但没有产出 exe");
const sha256 = createHash("sha256").update(readFileSync(setupExe)).digest("hex");
writeFileSync(`${setupExe}.sha256`, `${sha256}  ${basename(setupExe)}\n`, "ascii");

console.log(`\n产物：${setupExe}\n      ${mebibytes(statSync(setupExe).size)}`);
console.log(`版本：${version}。双击打开安装向导；自动验证可加 --quiet --target=<目录>。`);
console.log(`SHA-256：${sha256}`);

/**
 * Measured, not hypothetical: a probe passed `--build=D:\rcc-build` with `--staged=D:\rcc-build\mini` and the
 * default name, and `work` became `D:\rcc-build\MINI` — the same directory as `staged`, because Windows paths
 * are case-insensitive. `tar` then archived the `payload.zip` it was writing, so the package contained one
 * 0-byte entry, exited 0, and only the post-install check caught it. A build that overlaps the tree it is
 * packing is refused here instead of producing a silently empty installer, and the check runs before anything
 * is deleted, because the cleanup below would otherwise remove the tree it is guarding.
 */
function assertDisjoint(workDir, stagedDir) {
  const relations = [relative(resolve(stagedDir).toLowerCase(), resolve(workDir).toLowerCase()), relative(resolve(workDir).toLowerCase(), resolve(stagedDir).toLowerCase())];
  if (relations.some((inside) => inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)))) {
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
