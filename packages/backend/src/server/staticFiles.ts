import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { log } from "../observability/log.js";

/**
 * The built frontend, served by the process that owns the API. An installed app ships neither Vite nor
 * its devDependencies, so nothing else can hand out `index.html` — and the only way to do that without
 * taking on a static-serving dependency is to open exactly the file the URL names and nothing else.
 *
 * That last clause is the whole reason this file has tests: the root is fixed at boot, the accepted
 * characters are an allowlist, and a refused path and a missing file get the same answer, so a probe
 * cannot tell whether it found a wall or an empty room.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * A request path may only contain characters that appear in the file names this build emits.
 *
 * Percent-encoding is refused rather than decoded: the raw URL is the only thing this handler looks at,
 * and the moment a `%` is turned into a `/` or a `.` the containment check below is comparing a string
 * that is not the one the client sent. No asset Vite produces needs a percent sign in its name.
 */
const ALLOWED_PATH = /^\/[A-Za-z0-9._\-/]*$/;

/** Absolute path of the file *url* names inside *root*, or null when it names nothing that may be read. */
export function resolveStaticFile(root: string, url: string): string | null {
  const path = url.split("?")[0] ?? "/";
  if (!ALLOWED_PATH.test(path)) return null;
  // Anywhere in the string, not only as a whole segment. A name like `a..b` does not exist in this
  // build, and the price of the wider rule is a bypass nobody has to think that hard to find.
  if (path.includes("..")) return null;
  const candidate = resolve(root, path.slice(1));
  const boundary = root.endsWith("/") || root.endsWith("\\") ? root : `${root}${separator()}`;
  // Windows paths compare case-insensitively, so the containment test has to as well: `C:\ROOT\..` and
  // `c:\root\..` are the same directory, and an exact-string check would let one of them through.
  const fold = process.platform === "win32";
  const key = fold ? candidate.toLowerCase() : candidate;
  const prefix = fold ? boundary.toLowerCase() : boundary;
  return key.startsWith(prefix) ? candidate : null;
}

function separator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

async function readRegularFile(filePath: string): Promise<Buffer | null> {
  try {
    const info = await stat(filePath);
    // A directory is refused rather than listed: `GET /assets` answers 404 like any missing file.
    if (!info.isFile()) return null;
    return await readFile(filePath);
  } catch {
    // Either it vanished between the mount and the request (a re-install replacing the app dir) or the
    // root is unreadable. Neither is the client's business, and none is worth a 500 with a stack in it.
    return null;
  }
}

function applyHeaders(reply: FastifyReply, filePath: string, hashedAsset: boolean): void {
  const type = CONTENT_TYPES[extname(filePath).toLowerCase()];
  reply.header("content-type", type ?? "application/octet-stream");
  reply.header("x-content-type-options", "nosniff");
  // Hashed names change when the content changes, so they may be cached forever; `index.html` may not,
  // because a stale copy is one that points at asset names the new build already deleted.
  reply.header("cache-control", hashedAsset ? "public, max-age=31536000, immutable" : "no-cache");
}

/**
 * Mount `index.html` at `/` and the rest of *root* under `/*`. Returns false — and mounts nothing — when
 * the build isn't there, which is the normal state of a source checkout: `vite dev` still serves the page
 * and the API keeps its own routes.
 */
export function registerStaticFiles(app: FastifyInstance, root: string): boolean {
  const index = resolve(root, "index.html");
  if (!existsSync(index)) {
    log.debug("static host disabled: no index.html", { root });
    return false;
  }
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });

  app.get("/", async (_request, reply) => {
    const bytes = await readRegularFile(index);
    if (!bytes) return notFound(reply);
    applyHeaders(reply, index, false);
    return reply.send(bytes);
  });

  app.get("/*", async (request, reply) => {
    const file = resolveStaticFile(root, request.url);
    if (!file) {
      log.warn("static request refused", { url: request.url });
      return notFound(reply);
    }
    const bytes = await readRegularFile(file);
    if (!bytes) return notFound(reply);
    applyHeaders(reply, file, request.url.startsWith("/assets/"));
    return reply.send(bytes);
  });

  log.info("static host mounted", { root });
  return true;
}
