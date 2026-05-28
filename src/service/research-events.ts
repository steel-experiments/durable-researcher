// ABOUTME: Durable lifecycle event ledger for ResearchRun polling and future SSE.
// ABOUTME: Keeps API-visible status history independent of process-local emitters.

import { getDbPool } from "../db-pool.js";

let schemaReady = false;

export type ResearchRunEvent = {
  id: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

type ResearchRunEventRow = {
  id: string | number;
  run_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
};

function rowToEvent(row: ResearchRunEventRow): ResearchRunEvent {
  return {
    id: Number(row.id),
    runId: row.run_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export async function ensureResearchEventSchema(): Promise<void> {
  if (schemaReady) return;
  await getDbPool().query(`
    CREATE TABLE IF NOT EXISTS research_run_events (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
      type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  schemaReady = true;
}

export async function recordResearchEvent(input: {
  runId: string;
  type: string;
  payload?: Record<string, unknown>;
}): Promise<ResearchRunEvent> {
  await ensureResearchEventSchema();
  const result = await getDbPool().query(
    `INSERT INTO research_run_events (run_id, type, payload)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.runId, input.type, JSON.stringify(input.payload ?? {})],
  );
  return rowToEvent(result.rows[0]);
}

export async function listResearchEvents(
  runId: string,
  opts: { afterId?: number; limit?: number } = {},
): Promise<ResearchRunEvent[]> {
  await ensureResearchEventSchema();
  const result = await getDbPool().query(
    `SELECT * FROM research_run_events
      WHERE run_id = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [runId, opts.afterId ?? 0, opts.limit ?? 100],
  );
  return result.rows.map(rowToEvent);
}
