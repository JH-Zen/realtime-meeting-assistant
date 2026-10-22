import { SESSION_DOCUMENT_SCHEMA_VERSION, type SessionDocument } from "@rcc/shared";
import type { SqliteGraphRepository } from "../store/graphRepository.js";
import type { SqliteQaRepository } from "../store/qaRepository.js";
import type { SqliteSessionRepository } from "../store/sessionRepository.js";
import type { SqliteSummaryRepository } from "../store/summaryRepository.js";
import type { SqliteTranscriptRepository } from "../store/transcriptRepository.js";

/**
 * Reads one finished session back out as a `SessionDocument` (§13 OPEN-10). Every repository method
 * here already took an explicit `sessionId` — the ability to read any session existed, what was
 * missing was a caller (§13 OPEN-10 ①). That is the whole reason this is an assembly and not a new
 * query layer.
 */
export interface ExportRepositories {
  sessions: SqliteSessionRepository;
  transcripts: SqliteTranscriptRepository;
  graphs: SqliteGraphRepository;
  summaries: SqliteSummaryRepository;
  qa: SqliteQaRepository;
}

/** `undefined` when no such session exists — the caller turns that into a 404, not an empty file. */
export function exportSessionDocument(
  repos: ExportRepositories,
  sessionId: string,
  now = Date.now(),
): SessionDocument | undefined {
  const session = repos.sessions.get(sessionId);
  if (!session) return undefined;

  // Only dragged coordinates are written. A layout-derived one is a function of the tree, and
  // freezing it would make the file disagree with the map the next time it grows.
  const positions: SessionDocument["positions"] = {};
  for (const [nodeId, position] of Object.entries(repos.graphs.loadPositions(sessionId))) {
    if (position.pinned) positions[nodeId] = { x: position.x, y: position.y };
  }

  return {
    schemaVersion: SESSION_DOCUMENT_SCHEMA_VERSION,
    exportedAt: now,
    session,
    transcripts: repos.transcripts.listFinal(sessionId),
    nodes: repos.graphs.loadNodes(sessionId),
    edges: repos.graphs.loadEdges(sessionId),
    positions,
    summaries: repos.summaries.list(sessionId),
    exchanges: repos.qa.listExchanges(sessionId).map((entry) => ({
      question: {
        id: entry.question.id,
        text: entry.question.text,
        createdAt: entry.question.createdAt,
        snapshotId: entry.question.snapshotId,
      },
      answer: entry.answer
        ? {
            questionId: entry.answer.questionId,
            text: entry.answer.text,
            citations: entry.answer.citations,
            durationMs: entry.answer.durationMs,
            degraded: entry.answer.degraded,
            createdAt: entry.answer.createdAt,
          }
        : null,
    })),
  };
}

/** The filename a browser saves when the user clicks export. Id-based so two exports never collide. */
export function sessionFileName(sessionId: string): string {
  return `session-${sessionId}.json`;
}
