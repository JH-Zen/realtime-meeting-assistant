import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveModules, missingEmbeddingModules, type ModuleId, type ModuleStatus } from "../src/observability/modules.js";

/**
 * Optional modules are reported from the filesystem (`/health`, `RCC-modules.bat`), so this is the check that
 * the report matches what the app can actually load. The rule each case tests is the same one: say "installed"
 * only when the component that reads those files would get past its own first step — a menu that claims a
 * module is present is worse than one that admits it is not, because the user then has nothing to look for.
 */

function touch(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "", "utf8");
}

function status(modules: ModuleStatus[], id: ModuleId): ModuleStatus {
  const found = modules.find((module) => module.id === id);
  if (!found) throw new Error(`no status for ${id}`);
  return found;
}

function probe(root: string) {
  return { root, embeddingModelDir: join(root, "models", "embedding"), embeddingModel: "Xenova/bge-m3" };
}

describe("optional module presence", () => {
  it("reports every module missing on a bare install", () => {
    const root = mkdtempSync(join(tmpdir(), "rcc-modules-empty-"));
    const modules = deriveModules(probe(root));
    expect(modules.map((module) => module.installed)).toEqual([false, false, false]);
    // Every refusal has to name where it looked, or the next step is guessing.
    for (const module of modules) expect(module.checked.length).toBeGreaterThan(0);
  });

  it("counts M1 only when the transformers package is resolvable", () => {
    const root = mkdtempSync(join(tmpdir(), "rcc-modules-m1-"));
    expect(status(deriveModules(probe(root)), "m1").installed).toBe(false);
    touch(join(root, "node_modules", "@huggingface", "transformers", "package.json"));
    expect(status(deriveModules(probe(root)), "m1").installed).toBe(true);
  });

  it("counts M2 only when both the weights and the tokenizer are cached", () => {
    const root = mkdtempSync(join(tmpdir(), "rcc-modules-m2-"));
    const model = join(root, "models", "embedding", "Xenova", "bge-m3");
    touch(join(model, "tokenizer.json"));
    expect(status(deriveModules(probe(root)), "m2").installed).toBe(false);
    // A half-copied model is the common failure here: the directory exists, the download did not finish.
    touch(join(model, "config.json"));
    expect(status(deriveModules(probe(root)), "m2").installed).toBe(false);
    touch(join(model, "onnx", "model_quantized.onnx"));
    expect(status(deriveModules(probe(root)), "m2").installed).toBe(true);
  });

  it("sees M2 only for the configured model, not for some other one on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "rcc-modules-m2-model-"));
    const other = join(root, "models", "embedding", "Xenova", "bge-base-zh-v1.5");
    touch(join(other, "tokenizer.json"));
    touch(join(other, "onnx", "model_quantized.onnx"));
    expect(status(deriveModules(probe(root)), "m2").installed).toBe(false);
    // `EMBED_MODEL` is what the worker loads, so it is what the report has to follow.
    const switched = { ...probe(root), embeddingModel: "Xenova/bge-base-zh-v1.5" };
    expect(status(deriveModules(switched), "m2").installed).toBe(true);
  });

  it("counts M3 for a transducer model nested one level under models/stt", () => {
    const root = mkdtempSync(join(tmpdir(), "rcc-modules-m3-"));
    const model = join(root, "models", "stt", "sherpa-onnx-streaming-zipformer-bilingual");
    touch(join(model, "tokens.txt"));
    touch(join(model, "encoder.int8.onnx"));
    touch(join(model, "decoder.int8.onnx"));
    touch(join(model, "joiner.int8.onnx"));
    expect(status(deriveModules(probe(root)), "m3").installed).toBe(true);
  });

  it("counts M3 for a single-file CTC model too", () => {
    const root = mkdtempSync(join(tmpdir(), "rcc-modules-m3-ctc-"));
    const model = join(root, "models", "stt", "small-ctc");
    touch(join(model, "tokens.txt"));
    touch(join(model, "model.int8.onnx"));
    expect(status(deriveModules(probe(root)), "m3").installed).toBe(true);
  });

  it("refuses M3 when the worker itself would refuse the directory", () => {
    const root = mkdtempSync(join(tmpdir(), "rcc-modules-m3-partial-"));
    const model = join(root, "models", "stt", "no-tokens");
    // Weights without `tokens.txt`: `validate_model_paths` raises SystemExit on exactly this.
    touch(join(model, "encoder.onnx"));
    touch(join(model, "decoder.onnx"));
    touch(join(model, "joiner.onnx"));
    expect(status(deriveModules(probe(root)), "m3").installed).toBe(false);
    const empty = mkdtempSync(join(tmpdir(), "rcc-modules-m3-empty-"));
    mkdirSync(join(empty, "models", "stt", "just-readme"), { recursive: true });
    touch(join(empty, "models", "stt", "just-readme", "README.md"));
    expect(status(deriveModules(probe(empty)), "m3").installed).toBe(false);
  });

  it("treats a missing embedding module as a gap and the STT model as not one", () => {
    const root = mkdtempSync(join(tmpdir(), "rcc-modules-gaps-"));
    const modules = deriveModules(probe(root));
    expect(missingEmbeddingModules(modules).map((module) => module.id)).toEqual(["m1", "m2"]);
    touch(join(root, "node_modules", "@huggingface", "transformers", "package.json"));
    expect(missingEmbeddingModules(deriveModules(probe(root))).map((module) => module.id)).toEqual(["m2"]);
  });
});
