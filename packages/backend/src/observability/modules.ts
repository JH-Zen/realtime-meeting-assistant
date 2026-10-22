import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Optional-module presence (ADR §6.5 D-36).
 *
 * The installer ships core; M1/M2/M3 are added afterwards, by a separate package or by hand. Presence is
 * derived from the filesystem rather than read from a ledger written at build time, because such a ledger
 * describes the machine that built it: a model directory copied in afterwards, or deleted, leaves it
 * stating something false forever. These are also the only checks `RCC-modules.bat` prints, so the menu
 * and `/health` cannot disagree about whether the real embeddings are installed.
 *
 * Each entry reports what it looked for. A missing module is a fact a user can act on; a missing module
 * plus a path is a fact they can debug.
 */

export type ModuleId = "m1" | "m2" | "m3";

export interface ModuleStatus {
  id: ModuleId;
  label: string;
  installed: boolean;
  /** Absolute paths this check inspected, in order. */
  checked: string[];
  /** What to do when `installed` is false, in the user's terms. */
  remedy: string;
}

export interface ModuleProbe {
  /** Install root — the directory `packages/` and `node_modules/` hang off. */
  root: string;
  embeddingModelDir: string;
  /** `Xenova/bge-m3`: the slash is a directory level inside the transformers cache layout. */
  embeddingModel: string;
}

/** The package `embeddingWorker.ts` imports; without it the worker thread cannot start at all. */
const EMBEDDING_RUNTIME = join("node_modules", "@huggingface", "transformers", "package.json");
/** A weights file the worker can load — dtype-dependent, so matched by suffix rather than by name. */
const ONNX_WEIGHT = /\.onnx$/i;

function hasFile(dir: string, matches: (name: string) => boolean): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => {
    const path = join(dir, name);
    return matches(name) && statSync(path).isFile();
  });
}

/**
 * What `stt_worker.py` calls a usable model: `tokens.txt` plus either a transducer triple or one CTC file.
 * Mirroring the worker's own rule matters — a menu that says "已装" for a directory the worker then refuses
 * to start is worse than one that says "未装".
 */
function isSherpaModel(dir: string): boolean {
  if (!existsSync(join(dir, "tokens.txt"))) return false;
  const transducer = ["encoder", "decoder", "joiner"].every((part) =>
    hasFile(dir, (name) => name.startsWith(part) && ONNX_WEIGHT.test(name)),
  );
  return transducer || hasFile(dir, (name) => name.startsWith("model") && ONNX_WEIGHT.test(name));
}

function sherpaModelCandidates(root: string): string[] {
  const base = join(root, "models", "stt");
  const out = [base];
  try {
    for (const name of readdirSync(base)) {
      const path = join(base, name);
      if (statSync(path).isDirectory()) out.push(path);
    }
  } catch {
    // `models/stt` absent is the ordinary not-installed case, not an error to report.
  }
  return out;
}

export function deriveModules(probe: ModuleProbe): ModuleStatus[] {
  const runtimePath = join(probe.root, EMBEDDING_RUNTIME);
  const cachedModel = join(probe.embeddingModelDir, ...probe.embeddingModel.split("/"));
  const sttCandidates = sherpaModelCandidates(probe.root);

  return [
    {
      id: "m1",
      label: "M1 真实 embedding 运行时（@huggingface/transformers + onnxruntime）",
      installed: existsSync(runtimePath),
      checked: [runtimePath],
      remedy: "运行 RCC-M1-Setup.exe，把它装到同一个目录（默认 %LOCALAPPDATA%\\Programs\\RCC）",
    },
    {
      id: "m2",
      label: `M2 嵌入模型权重（${probe.embeddingModel}）`,
      // The cache holds `onnx/*.onnx` next to `tokenizer.json`; either missing means a download, which is
      // exactly what the offline install is supposed to remove.
      installed:
        existsSync(cachedModel) &&
        hasFile(join(cachedModel, "onnx"), (name) => ONNX_WEIGHT.test(name)) &&
        existsSync(join(cachedModel, "tokenizer.json")),
      checked: [join(cachedModel, "onnx"), join(cachedModel, "tokenizer.json")],
      remedy: `把你拿到的 M2 模型目录放到 ${cachedModel}（里面要有 onnx\\*.onnx 与 tokenizer.json），然后重启 RCC.bat`,
    },
    {
      id: "m3",
      label: "M3 sherpa-onnx 语音识别模型",
      installed: sttCandidates.some(isSherpaModel),
      checked: sttCandidates,
      remedy:
        "把你拿到的 M3 模型目录（含 tokens.txt 与 encoder/decoder/joiner 或 model*.onnx）放到 models\\stt\\ 下，再在另一个终端启动 worker：" +
        "python services\\stt-worker\\stt_worker.py --model-dir models\\stt\\<模型目录> --port 6006" +
        "（需先 pip install -r services\\stt-worker\\requirements.txt）",
    },
  ];
}

/** The modules the real embedding path needs, i.e. everything a `MOCK_EMBEDDING=false` start is short of. */
export function missingEmbeddingModules(modules: readonly ModuleStatus[]): ModuleStatus[] {
  return modules.filter((module) => module.id === "m1" || module.id === "m2").filter((module) => !module.installed);
}
