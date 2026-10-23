import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function validateDesktopVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) throw new Error(`Invalid desktop version: ${String(version)}`);
  const dash = version.indexOf("-");
  const base = dash === -1 ? version : version.slice(0, dash);
  const prerelease = dash === -1 ? "" : version.slice(dash + 1);
  if (prerelease?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error(`Invalid prerelease number: ${version}`);
  const sequence = version.match(/\.(\d+)$/)?.[1];
  const numeric = [...base.split("."), prerelease && sequence ? sequence : "0"].map(Number);
  if (numeric.some((part) => !Number.isSafeInteger(part) || part > 65535)) throw new Error(`Version exceeds Windows file-version limits: ${version}`);
  return { version, windowsVersion: numeric.join(".") };
}

export function readDesktopVersion(repo = root) {
  return validateDesktopVersion(JSON.parse(readFileSync(join(repo, "packages/desktop/package.json"), "utf8")).version).version;
}

export function stagedDesktopVersion(staged, expected = readDesktopVersion()) {
  const version = JSON.parse(readFileSync(join(staged, "resources/app/package.json"), "utf8")).version;
  const recorded = JSON.parse(readFileSync(join(staged, "runtime-versions.json"), "utf8")).desktop;
  validateDesktopVersion(version);
  if (version !== expected || recorded !== version) throw new Error(`Desktop version mismatch: source=${expected}, staged=${version}, runtime=${recorded}. Rebuild and stage before packaging.`);
  return version;
}

export function setDesktopVersion(version, repo = root) {
  validateDesktopVersion(version);
  const desktopPath = join(repo, "packages/desktop/package.json");
  const lockPath = join(repo, "package-lock.json");
  const desktop = JSON.parse(readFileSync(desktopPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.packages?.["packages/desktop"]?.version !== desktop.version) throw new Error("Desktop package and lockfile versions disagree; repair them before setting a new version.");
  desktop.version = version;
  lock.packages["packages/desktop"].version = version;
  writeFileSync(desktopPath, `${JSON.stringify(desktop, null, 2)}\n`);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = process.argv.find((arg) => arg.startsWith("--set="))?.slice(6);
  console.log(next === undefined ? readDesktopVersion() : setDesktopVersion(next));
}
