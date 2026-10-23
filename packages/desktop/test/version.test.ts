import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readDesktopVersion, setDesktopVersion, stagedDesktopVersion, validateDesktopVersion } from "../../../tools/desktop-version.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rcc-version-"));
  mkdirSync(join(root, "packages/desktop"), { recursive: true });
  writeFileSync(join(root, "packages/desktop/package.json"), JSON.stringify({ name: "@rcc/desktop", version: "0.1.0-desktop-preview.4" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "packages/desktop": { version: "0.1.0-desktop-preview.4" } } }));
  return { root, close: () => { if (dirname(root) !== tmpdir()) throw new Error("Unsafe fixture cleanup"); rmSync(root, { recursive: true }); } };
}

describe("desktop delivery version", () => {
  it("maps a prerelease sequence to Windows version metadata without losing its full label", () => {
    expect(validateDesktopVersion("0.1.0-desktop-preview.5")).toEqual({ version: "0.1.0-desktop-preview.5", windowsVersion: "0.1.0.5" });
    expect(validateDesktopVersion("1.2.3").windowsVersion).toBe("1.2.3.0");
  });

  it.each(["../preview", "0.1.0\nlabel=wrong", "01.2.3", "0.1.0-preview.01", "0.1.0-preview.65536", "0.1", "0.1.0-preview..5"])("refuses invalid or nonportable version %s", (version) => {
    expect(() => validateDesktopVersion(version)).toThrow();
  });

  it("updates package and lock metadata together", () => {
    const h = fixture();
    try {
      setDesktopVersion("0.1.0-desktop-preview.5", h.root);
      expect(readDesktopVersion(h.root)).toBe("0.1.0-desktop-preview.5");
      expect(JSON.parse(readFileSync(join(h.root, "package-lock.json"), "utf8")).packages["packages/desktop"].version).toBe("0.1.0-desktop-preview.5");
    } finally { h.close(); }
  });

  it("refuses stale package/lock state before changing either file", () => {
    const h = fixture();
    try {
      writeFileSync(join(h.root, "package-lock.json"), JSON.stringify({ packages: { "packages/desktop": { version: "wrong" } } }));
      const before = readFileSync(join(h.root, "packages/desktop/package.json"), "utf8");
      expect(() => setDesktopVersion("0.1.0-desktop-preview.5", h.root)).toThrow(/disagree/);
      expect(readFileSync(join(h.root, "packages/desktop/package.json"), "utf8")).toBe(before);
    } finally { h.close(); }
  });

  it("catches stale staging and inconsistent runtime metadata before installer creation", () => {
    const h = fixture();
    try {
      mkdirSync(join(h.root, "resources/app"), { recursive: true });
      writeFileSync(join(h.root, "resources/app/package.json"), JSON.stringify({ version: "0.1.0-desktop-preview.5" }));
      writeFileSync(join(h.root, "runtime-versions.json"), JSON.stringify({ desktop: "0.1.0-desktop-preview.4" }));
      expect(() => stagedDesktopVersion(h.root, "0.1.0-desktop-preview.5")).toThrow(/mismatch/);
      writeFileSync(join(h.root, "runtime-versions.json"), JSON.stringify({ desktop: "0.1.0-desktop-preview.5" }));
      expect(stagedDesktopVersion(h.root, "0.1.0-desktop-preview.5")).toBe("0.1.0-desktop-preview.5");
      expect(() => stagedDesktopVersion(h.root, "0.1.0-desktop-preview.6")).toThrow(/mismatch/);
    } finally { h.close(); }
  });
});
