// ABOUTME: Single process-wide pg.Pool — every Postgres consumer (task-finder, browse-cache,
// ABOUTME: cleanup) shares this instance instead of creating its own per-call pools.

import pg from "pg";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@localhost:5432/absurd";

let pool: pg.Pool | null = null;

/** Get the shared Pool, creating it lazily on first use. */
export function getDbPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DB_URL,
      max: 5,
    });
  }
  return pool;
}

/** End the shared Pool. Safe to call when no Pool exists. */
export async function closeDbPool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
