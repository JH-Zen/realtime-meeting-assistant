import { randomUUID } from "node:crypto";
import type { MindMapNode, TranscriptSegment } from "@rcc/shared";

/**
 * §32: the context is copied the moment the question is submitted, so transcript that arrives while
 * the model is thinking cannot change what this answer is based on. The id travels in
 * `answer.started`, which is how the client can tell that nothing was swapped in mid-flight.
 */
export interface ContextSnapshot {
  id: string;
  question: string;
  createdAt: number;
  globalSummary: string;
  relevantNodes: MindMapNode[];
  hotContext: TranscriptSegment[];
  relevantTranscripts: TranscriptSegment[];
}

export interface SnapshotInput {
  question: string;
  hotContext: TranscriptSegment[];
  nodes: MindMapNode[];
  /** Empty until embedding retrieval lands; the prompt renders the empty case as (暂无). */
  relevantTranscripts?: TranscriptSegment[];
  globalSummary?: string;
}

/** A token budget, not a quality judgement: four minutes of dense speech is already ~100 lines. */
const MAX_HOT_LINES = 80;
const MAX_NODES = 40;

export function buildContextSnapshot(input: SnapshotInput): ContextSnapshot {
  return {
    id: randomUUID(),
    question: input.question,
    createdAt: Date.now(),
    globalSummary: input.globalSummary ?? "",
    relevantNodes: input.nodes.slice(-MAX_NODES),
    hotContext: input.hotContext.slice(-MAX_HOT_LINES),
    relevantTranscripts: input.relevantTranscripts ?? [],
  };
}
