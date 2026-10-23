import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDesktopVersion } from "./desktop-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const work = resolve(option("work") ?? join(root, "work", `installer-wizard-${Date.now()}`));
if (existsSync(work)) throw new Error(`Use a new verification directory: ${work}`);
await mkdir(work, { recursive: true });
const stage = join(work, "stage");
const version = readDesktopVersion();
const identity = `RCC-Wizard-Test-${Date.now()}`;
for (const folder of ["runtime", "resources/app", "var", "models", "data"]) await mkdir(join(stage, folder), { recursive: true });
for (const [path, content] of Object.entries({ "runtime/node.exe": "installer test marker only", "resources/app/package.json": JSON.stringify({ version }), "runtime-versions.json": JSON.stringify({ desktop: version }), ".env": "TEMPLATE_CONFIG=true", "var/rcc.sqlite": "TEMPLATE DB MARKER", "models/keep.bin": "TEMPLATE MODEL", "data/keep.bin": "TEMPLATE DATA", "program-marker.txt": "NEW APP FILE", "guard.bin": "NEW GUARD FILE" })) await writeFile(join(stage, path), content);
await writeFile(join(stage, "progress-fixture.bin"), Buffer.alloc(8 * 1024 * 1024, 123));
const stub = join(work, "FixtureApp.cs");
await writeFile(stub, 'using System;using System.IO;internal static class FixtureApp{[STAThread]static void Main(){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"launched.txt"),"fixture only");}}');
const compiler = join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, ...options });
  assert.equal(result.status, 0, result.stdout || result.stderr || String(result.error));
  return result;
}
run(compiler, ["/nologo", "/target:winexe", `/out:${join(stage, "实时会议助手.exe")}`, stub]);
const out = join(work, "out");
run(process.execPath, [join(root, "tools/make-installer.mjs"), "--desktop", `--staged=${stage}`, `--build=${join(work, "build")}`, `--out=${out}`, `--shortcut=${identity}`]);
const installer = join(out, `RCC-Desktop-Preview-${version}-Setup.exe`);
assert.equal(run(installer, ["--version"]).stdout.trim(), version);
const binary = await readFile(installer);
assert.equal(binary.readUInt16LE(binary.readUInt32LE(0x3c) + 24 + 68), 2, "Installer must use the Windows GUI subsystem, without an extra console window");
const result = { ok: false, version, work, fixture: "installer-only-no-meeting-runtime", checks: ["quiet-version-command", "gui-subsystem-no-extra-console"] };
try {
  for (const args of [["--name=..", `--build=${work}`], ["--name=stage", `--build=${work}`]]) {
    const refused = spawnSync(process.execPath, [join(root, "tools/make-installer.mjs"), "--desktop", `--staged=${stage}`, `--out=${out}`, ...args], { encoding: "utf8", windowsHide: true });
    assert.notEqual(refused.status, 0);
    assert.equal(await readFile(join(stage, "program-marker.txt"), "utf8"), "NEW APP FILE");
  }
  const duplicate = spawnSync(process.execPath, [join(root, "tools/make-installer.mjs"), "--desktop", `--staged=${stage}`, `--build=${join(work, "build")}`, `--out=${out}`], { encoding: "utf8", windowsHide: true });
  assert.notEqual(duplicate.status, 0);
  assert.deepEqual(await readFile(installer), binary);
  result.checks.push("refuses-unsafe-build-cleanup-and-overlapping-stage", "refuses-overwriting-existing-versioned-installer");
  const native = run("powershell.exe", ["-NoProfile", "-STA", "-File", join(root, "tools/verify-installer-wizard.ps1"), "-Installer", installer, "-Work", work, "-Version", version, "-Shortcut", identity], { env: { ...process.env, RCC_INSTALLER_LOG_DIR: join(work, "logs") } });
  await writeFile(join(work, "wizard-ui.log"), native.stdout + native.stderr);
  const ui = JSON.parse((await readFile(join(work, "wizard-ui.json"), "utf8")).replace(/^\uFEFF/, ""));
  assert.equal(ui.ok, true); result.checks.push(...ui.checks);
  const target = join(work, "静默 中文 app");
  run(installer, [`--target=${target}`, "--quiet", "--no-shortcut"], { env: { ...process.env, RCC_INSTALLER_LOG_DIR: join(work, "logs") } });
  assert.equal((await readFile(join(target, "installed-version.txt"), "utf8")).trim(), version);
  await writeFile(join(target, ".env"), "KEEP_USER_CONFIG=true");
  run(installer, [`--target=${target}`, "--quiet", "--no-shortcut"], { env: { ...process.env, RCC_INSTALLER_LOG_DIR: join(work, "logs") } });
  assert.equal(await readFile(join(target, ".env"), "utf8"), "KEEP_USER_CONFIG=true");
  result.checks.push("quiet-install-and-reinstall-retain-config"); result.ok = true;
} catch (error) { result.error = String(error); throw error; }
finally { await writeFile(join(work, "verification.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
