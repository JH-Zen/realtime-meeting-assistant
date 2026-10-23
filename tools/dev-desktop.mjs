import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const env = { ...process.env, RCC_DESKTOP_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [resolve(root, "packages/desktop"), ...process.argv.slice(2)], {
  cwd: root, env, stdio: "inherit", windowsHide: true,
});
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
