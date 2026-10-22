import type { DatabaseSync } from "node:sqlite";
import type { MindMapEdge, MindMapNode } from "@rcc/shared";

export class SqliteGraphRepository {
  private insideTx = false;

  constructor(private readonly db: DatabaseSync) {}

  loadNodes(sessionId: string): MindMapNode[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, summary, parent_id, source_transcript_ids, confidence, created_at, updated_at
         FROM mindmap_nodes WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as unknown as NodeRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
      sourceTranscriptIds: parseIds(row.source_transcript_ids),
      ...(row.confidence !== null ? { confidence: Number(row.confidence) } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  loadEdges(sessionId: string): MindMapEdge[] {
    const rows = this.db
      .prepare(`SELECT id, source, target, relation FROM mindmap_edges WHERE session_id = ?`)
      .all(sessionId) as unknown as EdgeRow[];
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      target: row.target,
      ...(row.relation !== null ? { relation: row.relation } : {}),
    }));
  }

  upsertNode(sessionId: string, node: MindMapNode): void {
    this.db
      .prepare(
        `INSERT INTO mindmap_nodes
         (id, session_id, title, summary, parent_id, source_transcript_ids, confidence, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, id) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           parent_id = excluded.parent_id,
           source_transcript_ids = excluded.source_transcript_ids,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run(
        node.id,
        sessionId,
        node.title,
        node.summary ?? null,
        node.parentId ?? null,
        JSON.stringify(node.sourceTranscriptIds),
        node.confidence ?? null,
        node.createdAt,
        node.updatedAt,
      );
  }

  deleteNode(sessionId: string, nodeId: string): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM mindmap_nodes WHERE session_id = ? AND id = ?`).run(sessionId, nodeId);
      this.db
        .prepare(`DELETE FROM mindmap_edges WHERE session_id = ? AND (source = ? OR target = ?)`)
        .run(sessionId, nodeId, nodeId);
      this.db
        .prepare(`DELETE FROM graph_positions WHERE session_id = ? AND node_id = ?`)
        .run(sessionId, nodeId);
    });
  }

  /**
   * Hierarchy survives in `mindmap_nodes.parent_id`; this table only carries the cross-links an
   * `add_edge` op created, and nothing else writes it. The in-memory graph is authoritative and the
   * set is small, so the session's edges are re-mirrored whole instead of tracking which op touched
   * which edge — otherwise a proposed link is live until the process restarts and then vanishes.
   */
  saveEdges(sessionId: string, edges: readonly MindMapEdge[]): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM mindmap_edges WHERE session_id = ?`).run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO mindmap_edges (id, session_id, source, target, relation) VALUES (?,?,?,?,?)
         ON CONFLICT(session_id, id) DO NOTHING`,
      );
      for (const edge of edges) insert.run(edge.id, sessionId, edge.source, edge.target, edge.relation ?? null);
    });
  }

  savePosition(sessionId: string, nodeId: string, x: number, y: number, pinned: boolean): void {
    this.db
      .prepare(
        `INSERT INTO graph_positions (session_id, node_id, x, y, pinned) VALUES (?,?,?,?,?)
         ON CONFLICT(session_id, node_id) DO UPDATE SET x = excluded.x, y = excluded.y, pinned = excluded.pinned`,
      )
      .run(sessionId, nodeId, x, y, pinned ? 1 : 0);
  }

  loadPositions(sessionId: string): Record<string, { x: number; y: number; pinned: boolean }> {
    const rows = this.db
      .prepare(`SELECT node_id, x, y, pinned FROM graph_positions WHERE session_id = ?`)
      .all(sessionId) as unknown as PositionRow[];
    const out: Record<string, { x: number; y: number; pinned: boolean }> = {};
    for (const row of rows) {
      out[row.node_id] = { x: Number(row.x), y: Number(row.y), pinned: row.pinned === 1 };
    }
    return out;
  }

  recordOperation(
    sessionId: string,
    opId: string,
    type: string,
    responseId: string | undefined,
    payload: unknown,
    createdAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO graph_operations (op_id, session_id, response_id, type, payload, created_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(op_id) DO NOTHING`,
      )
      .run(opId, sessionId, responseId ?? null, type, JSON.stringify(payload), createdAt);
  }

  seenOpIds(sessionId: string): string[] {
    const rows = this.db
      .prepare(`SELECT op_id FROM graph_operations WHERE session_id = ?`)
      .all(sessionId) as { op_id: string }[];
    return rows.map((row) => row.op_id);
  }

  recentOperations(sessionId: string, limit: number): { type: string; payload: string; createdAt: number }[] {
    const rows = this.db
      .prepare(
        `SELECT type, payload, created_at FROM graph_operations
         WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as { type: string; payload: string; created_at: number }[];
    return rows.map((row) => ({ type: row.type, payload: row.payload, createdAt: Number(row.created_at) }));
  }

  /**
   * A multi-statement write that is not one transaction can fail half-way and leave the database in a
   * state the in-memory graph never had — cleared edges, or a node gone while its edge rows stay.
   * The next restart reads that half-state back as truth, so these pairs commit or not at all.
   *
   * Re-entrant by design: `applyOps` opens one transaction for a whole batch, and the per-table
   * mirrors below then join it instead of nesting a `BEGIN`, which SQLite would reject outright.
   */
  transaction(write: () => void): void {
    if (this.insideTx) {
      write();
      return;
    }
    this.insideTx = true;
    this.db.exec("BEGIN");
    try {
      write();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.insideTx = false;
    }
  }
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

interface NodeRow {
  id: string;
  title: string;
  summary: string | null;
  parent_id: string | null;
  source_transcript_ids: string;
  confidence: number | null;
  created_at: number;
  updated_at: number;
}

interface EdgeRow {
  id: string;
  source: string;
  target: string;
  relation: string | null;
}

interface PositionRow {
  node_id: string;
  x: number;
  y: number;
  pinned: number;
}
