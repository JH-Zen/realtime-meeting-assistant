import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { registerStaticFiles, resolveStaticFile } from "../src/server/staticFiles.js";

/**
 * Two things have to be true of the static host before an installer can ship it: the page and its assets
 * must actually arrive, and a URL must not be able to name a file outside the build. The second one is
 * the reason `resolveStaticFile` is exported — the traversal cases are checked as a pure function first,
 * so a refusal that only looks right because the HTTP layer normalised the URL on the way in cannot pass
 * as a guard.
 */

const SECRET = "not-part-of-the-build";
const INDEX = '<!doctype html><title>实时认知助手</title><div id="root"></div>';
const BUNDLE = "console.log('rcc');\n";

let root = "";
let outside = "";

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "rcc-static-"));
  root = join(base, "app");
  outside = join(base, "private");
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "nested"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "index.html"), INDEX, "utf8");
  await writeFile(join(root, "assets", "index-abc123.js"), BUNDLE, "utf8");
  await writeFile(join(root, "assets", "index-abc123.css"), "body{}", "utf8");
  await writeFile(join(root, "no-such-type.dat"), BUNDLE, "utf8");
  await writeFile(join(outside, "secret.txt"), SECRET, "utf8");
  // A file whose name is also an API route: the more specific pattern has to win, or `/api/session`
  // would silently become a downloadable page the day someone rebuilds the frontend into the same root.
  await mkdir(join(root, "api"), { recursive: true });
  await writeFile(join(root, "api", "session"), SECRET, "utf8");
});

function build() {
  const app = Fastify({ logger: false });
  app.get("/api/session", () => ({ sessionId: null }));
  app.get("/health", () => ({ ok: true }));
  const mounted = registerStaticFiles(app, root);
  return { app, mounted };
}

describe("resolveStaticFile", () => {
  const rootPath = resolve(root);

  it("accepts the names a Vite build emits", () => {
    expect(resolveStaticFile(rootPath, "/index.html")).toBe(join(rootPath, "index.html"));
    expect(resolveStaticFile(rootPath, "/assets/index-abc123.js")).toBe(join(rootPath, "assets", "index-abc123.js"));
    expect(resolveStaticFile(rootPath, "/assets/index-abc123.js?v=2&x=1")).toBe(
      join(rootPath, "assets", "index-abc123.js"),
    );
  });

  it("refuses traversal in every form that has been used to bypass a containment check", () => {
    const refused = [
      "/../secret.txt",
      "/assets/../../private/secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E%5Csecret.txt",
      "/\\..\\secret.txt",
      "/assets/secret.txt\u0000.js",
      "/a b.txt",
      "/café.css",
    ];
    for (const url of refused) {
      expect(resolveStaticFile(rootPath, url), url).toBeNull();
    }
  });

  it("refuses a path that looks relative but resolves outside, and one that resolves to the root itself", () => {
    // No leading separator: `resolve()` would take the second argument as absolute and return it.
    expect(resolveStaticFile(rootPath, "//private/secret.txt")).toBeNull();
    expect(resolveStaticFile(rootPath, "/")).toBeNull();
    expect(resolveStaticFile(rootPath, "")).toBeNull();
  });

  it("keeps the containment check case-insensitive where the filesystem is", () => {
    const folded = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
    expect(resolveStaticFile(folded, "/index.html")).toBe(join(folded, "index.html"));
  });
});

describe("the mounted routes", () => {
  it("mounts nothing when the build is not on disk", async () => {
    const app = Fastify({ logger: false });
    expect(registerStaticFiles(app, join(root, "nested", "empty-dir"))).toBe(false);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
  });

  it("serves index.html at / without caching it", async () => {
    const { app, mounted } = build();
    expect(mounted).toBe(true);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toBe(INDEX);
  });

  it("caches a hashed asset forever and marks the type the browser needs", async () => {
    const { app } = build();
    const js = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
    expect(js.body).toBe(BUNDLE);

    const css = await app.inject({ method: "GET", url: "/assets/index-abc123.css?v=1" });
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");

    const unknown = await app.inject({ method: "GET", url: "/no-such-type.dat" });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.headers["content-type"]).toBe("application/octet-stream");
  });

  it("answers 404 without a listing, a body, or a hint about which one happened", async () => {
    const { app } = build();
    for (const url of ["/nested", "/missing.js", "/assets/nope.js", "/%2e%2e/secret.txt", "/../private/secret.txt"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain(SECRET);
      expect(res.body, url).not.toContain("index-abc123");
    }
  });

  it("keeps the API routes ahead of the fallback", async () => {
    const { app } = build();
    const api = await app.inject({ method: "GET", url: "/api/session" });
    expect(api.statusCode).toBe(200);
    expect(api.json()).toEqual({ sessionId: null });
    expect(api.body).not.toContain(SECRET);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toEqual({ ok: true });
  });
});
