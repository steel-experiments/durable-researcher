// ABOUTME: Persistence helpers for public ResearchRun artifacts.
// ABOUTME: Stores final reports and intermediate harness outputs independently of campaign internals.

import { getDbPool } from "../db-pool.js";

let schemaReady = false;

export type ResearchArtifact = {
  id: number;
  runId: string;
  kind: string;
  contentType: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

type ResearchArtifactRow = {
  id: string | number;
  run_id: string;
  kind: string;
  content_type: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

function rowToArtifact(row: ResearchArtifactRow): ResearchArtifact {
  return {
    id: Number(row.id),
    runId: row.run_id,
    kind: row.kind,
    contentType: row.content_type,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function ensureResearchArtifactSchema(): Promise<void> {
  if (schemaReady) return;
  await getDbPool().query(`
    CREATE TABLE IF NOT EXISTS research_run_artifacts (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
      kind text NOT NULL,
      content_type text NOT NULL,
      content text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  schemaReady = true;
}

export async function saveResearchArtifact(input: {
  runId: string;
  kind: string;
  contentType: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<ResearchArtifact> {
  await ensureResearchArtifactSchema();
  const result = await getDbPool().query(
    `INSERT INTO research_run_artifacts (run_id, kind, content_type, content, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.runId, input.kind, input.contentType, input.content, JSON.stringify(input.metadata ?? {})],
  );
  return rowToArtifact(result.rows[0]);
}

export async function listResearchArtifacts(runId: string): Promise<ResearchArtifact[]> {
  await ensureResearchArtifactSchema();
  const result = await getDbPool().query(
    `SELECT * FROM research_run_artifacts WHERE run_id = $1 ORDER BY created_at ASC, id ASC`,
    [runId],
  );
  return result.rows.map(rowToArtifact);
}

export async function latestResearchArtifact(runId: string, kind: string): Promise<ResearchArtifact | null> {
  await ensureResearchArtifactSchema();
  const result = await getDbPool().query(
    `SELECT * FROM research_run_artifacts
      WHERE run_id = $1 AND kind = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [runId, kind],
  );
  return result.rows[0] ? rowToArtifact(result.rows[0]) : null;
}
