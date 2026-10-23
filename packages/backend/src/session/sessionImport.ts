import type { EmbeddingProvider } from "../retrieval/EmbeddingProvider.js";
import { toUnitVector } from "../retrieval/vector.js";
import type { ExportRepositories } from "./sessionExport.js";
import type { SqliteEmbeddingRepository, EmbeddingWrite } from "../store/embeddingRepository.js";
import { log } from "../observability/log.js";
import { parseSessionDocument } from "@rcc/shared";

/**
 * Import one exported session under a **new** id (§13 OPEN-10, decided 2026-10-21: an imported
 * session is a history you can still ask questions about, and it can never keep recording).
 *
 * Two findings from reading the schema decide the shape of this file, and both narrow what earlier
 * notes assumed:
 * - Only `questions.id` and `answers.id` are globally unique (TEXT primary key). Every other table is
 *   keyed `(session_id, id)`, so restamping `session_id` alone separates the copy from the original.
 *   OPEN-10 ③ listed `parent_id`, edge endpoints, `source_block_ids` and `owner_id` as rewrite
 *   candidates; none of them needs rewriting, and leaving them alone is what keeps every citation and
 *   parent link resolvable without a translation table.
 * - Nothing here needs a new runtime. `SessionRuntime` hydrates from the store in its constructor, so
 *   rows written correctly are already askable (see `RecordingController.openHistory`).
 *
 * Vectors are the one thing that cannot be copied, because the document deliberately carries none:
 * they are re-indexed through the same provider the session would have used live.
 */

export interface ImportRepositories extends ExportRepositories {
  embeddings: SqliteEmbeddingRepository;
}

export interface ImportTarget {
  /** Chosen by the caller (`randomUUID()`); a fixed id would let a second import collide. */
  sessionId: string;
  now?: number;
  batchSize?: number;
}

export interface ImportCounts {
  transcripts: number;
  /** Non-`final` rows refused, because §14 bars partials from every downstream index. */
  transcriptsSkipped: number;
  nodes: number;
  edges: number;
  positions: number;
  summaries: number;
  questions: number;
  answers: number;
  embedded: number;
  /** The session is readable and askable from Hot Context and the summaries, but not from the index. */
  embeddingError?: string;
}

export type ImportOutcome =
  | { ok: true; sessionId: string; counts: ImportCounts }
  | { ok: false; issues: string[] };

const DEFAULT_BATCH_SIZE = 32;

export async function importSessionDocument(
  repos: ImportRepositories,
  raw: unknown,
  embedding: EmbeddingProvider,
  target: ImportTarget,
): Promise<ImportOutcome> {
  const now = target.now ?? Date.now();
  const parsed = parseSessionDocument(raw);
  if (!parsed.document) {
    return { ok: false, issues: parsed.issues.length > 0 ? parsed.issues : ["文件不是一份会话文档"] };
  }
  if (parsed.issues.length > 0) return { ok: false, issues: parsed.issues };
  const document = parsed.document;
  if (document.audioGaps?.length && !repos.audioGaps) return { ok: false, issues: ["此运行环境不支持保存音频缺口记录，未导入以避免丢失信息。"] };

  if (repos.sessions.get(target.sessionId)) {
    return { ok: false, issues: [`会话 "${target.sessionId}" 已存在，导入会覆盖它已有的行`] };
  }

  // A partial is refused here rather than reaching `appendFinal`, which throws: inside the write
  // transaction that would roll back the whole file, so one hand-edited row would destroy 3000
  // usable ones. Dropping it costs the imported session a row the exporter could never have written.
  const finals = document.transcripts.filter((segment) => segment.type === "final");
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  // `graph_positions` has no foreign key, so an orphan coordinate would be stored and silently
  // ignored on load — better to skip it and say how many were.
  const positions = Object.entries(document.positions).filter(([nodeId]) => nodeIds.has(nodeId));
  const exchanges = document.exchanges.filter((entry) => entry.answer !== null);

  repos.graphs.transaction(() => {
    // `completed` whatever the file said: the recording that produced it is over, and an imported
    // session that looked live would offer a record button that could never fill it. `startedAt` is
    // kept because every transcript `startTime` is measured from it.
    repos.sessions.create({
      id: target.sessionId,
      ...(document.session.title !== undefined ? { title: document.session.title } : {}),
      startedAt: document.session.startedAt,
      endedAt: document.session.endedAt ?? now,
      ...(document.session.durationSec === undefined ? {} : { durationSec: document.session.durationSec }),
      status: "completed",
    });
    for (const segment of finals) repos.transcripts.appendFinal({ ...segment, sessionId: target.sessionId });
    for (const gap of document.audioGaps ?? []) repos.audioGaps?.save({ ...gap, sessionId: target.sessionId });
    for (const node of document.nodes) repos.graphs.upsertNode(target.sessionId, node);
    repos.graphs.saveEdges(target.sessionId, document.edges);
    for (const [nodeId, position] of positions) {
      repos.graphs.savePosition(target.sessionId, nodeId, position.x, position.y, true);
    }
    for (const block of document.summaries) repos.summaries.append({ ...block, sessionId: target.sessionId });
    for (const entry of document.exchanges) {
      const id = importQuestionId(target.sessionId, entry.question.id);
      repos.qa.recordQuestion({
        id,
        sessionId: target.sessionId,
        text: entry.question.text,
        createdAt: entry.question.createdAt,
        // Copied verbatim. It names a context snapshot that was never persisted (OPEN-10 ⑤), so the
        // import keeps it as provenance and nothing dereferences it.
        snapshotId: entry.question.snapshotId,
      });
      if (!entry.answer) continue;
      // `answers.id == questions.id` and `answers.question_id` both take the rewritten id, so the
      // invariant the store relies on survives the copy.
      repos.qa.recordAnswer({
        questionId: id,
        sessionId: target.sessionId,
        text: entry.answer.text,
        citations: entry.answer.citations,
        durationMs: entry.answer.durationMs,
        degraded: entry.answer.degraded,
        createdAt: entry.answer.createdAt,
      });
    }
  });

  // Outside the transaction: `putBatch` opens its own `BEGIN`, and a nested one is an SQLite error.
  const index = await reindex(repos, target.sessionId, finals, embedding, target.batchSize ?? DEFAULT_BATCH_SIZE);

  const counts: ImportCounts = {
    transcripts: finals.length,
    transcriptsSkipped: document.transcripts.length - finals.length,
    nodes: document.nodes.length,
    edges: document.edges.length,
    positions: positions.length,
    summaries: document.summaries.length,
    questions: document.exchanges.length,
    answers: exchanges.length,
    embedded: index.embedded,
    ...(index.error !== undefined ? { embeddingError: index.error } : {}),
  };
  log.info("session imported", { sessionId: target.sessionId, sourceSessionId: document.session.id, ...counts });
  return { ok: true, sessionId: target.sessionId, counts };
}

/** Transcript and node ids are not rewritten, so only the two global ones need a namespace. */
export function importQuestionId(sessionId: string, originalId: string): string {
  return `${sessionId}-${originalId}`;
}

/**
 * Rebuild the retrieval index the way a live session fills it (`RetrievalCore.drainBatch`): batch,
 * drop any vector whose length disagrees with the provider, normalise, write. Only transcripts are
 * indexed because that is all the live path indexes — a summary is answered from context, not search.
 *
 * A batch that fails does not fail the import. The rows are already committed and readable, and an
 * import that rolled back because the embedding model was down would throw away the session for a
 * hole the next question can work around.
 */
async function reindex(
  repos: ImportRepositories,
  sessionId: string,
  segments: readonly { id: string; text: string }[],
  provider: EmbeddingProvider,
  batchSize: number,
): Promise<{ embedded: number; error?: string }> {
  let embedded = 0;
  let error: string | undefined;
  for (let offset = 0; offset < segments.length; offset += batchSize) {
    const batch = segments.slice(offset, offset + batchSize);
    try {
      const vectors = await provider.embed(batch.map((segment) => segment.text));
      const usable = Math.min(batch.length, vectors.length);
      if (usable < batch.length) error = `期望 ${batch.length} 条向量，得到 ${usable} 条`;
      const rows: EmbeddingWrite[] = [];
      for (let i = 0; i < usable; i += 1) {
        const segment = batch[i];
        const vector = vectors[i];
        if (!segment || !vector || vector.length !== provider.dim) continue;
        rows.push({
          ownerType: "transcript",
          ownerId: segment.id,
          sessionId,
          provider: provider.name,
          vector: toUnitVector(vector),
        });
      }
      repos.embeddings.putBatch(rows);
      embedded += rows.length;
    } catch (caught: unknown) {
      error = caught instanceof Error ? caught.message : String(caught);
      log.warn("import re-index batch failed", { sessionId, offset, message: error });
    }
  }
  return error === undefined ? { embedded } : { embedded, error };
}
