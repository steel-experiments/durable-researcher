// ABOUTME: Postgres-backed cache for scraped page content keyed by (task_id, url).
// ABOUTME: Prevents re-scraping on crash/resume and benefits extend mode across tasks.

import pg from "pg";

export type CachedBrowse = {
  url: string;
  title: string;
  content: string;
  rawLength: number;
  scrapedAt: Date;
};

const DEFAULT_DB_URL = "postgresql://postgres:postgres@localhost:5432/absurd";

let pool: pg.Pool | null = null;
let tableInitialized = false;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DB_URL,
      max: 5,
    });
  }
  return pool;
}

/** Create the browse_cache table if it doesn't exist. */
async function ensureTable(): Promise<void> {
  if (tableInitialized) return;
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS browse_cache (
      task_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      content TEXT,
      raw_length INT,
      scraped_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (task_id, url)
    )
  `);
  tableInitialized = true;
}

/** Look up a cached browse result for a given task and URL. */
export async function getCachedBrowse(
  taskId: string,
  url: string,
): Promise<CachedBrowse | null> {
  await ensureTable();
  const p = getPool();
  const result = await p.query(
    `SELECT url, title, content, raw_length, scraped_at FROM browse_cache WHERE task_id = $1 AND url = $2`,
    [taskId, url],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    url: row.url,
    title: row.title,
    content: row.content,
    rawLength: row.raw_length,
    scrapedAt: row.scraped_at,
  };
}

/** Store a browse result in the cache. */
export async function setCachedBrowse(
  taskId: string,
  url: string,
  data: { title: string; content: string; rawLength: number },
): Promise<void> {
  await ensureTable();
  const p = getPool();
  await p.query(
    `INSERT INTO browse_cache (task_id, url, title, content, raw_length)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (task_id, url) DO UPDATE SET
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       raw_length = EXCLUDED.raw_length,
       scraped_at = NOW()`,
    [taskId, url, data.title, data.content, data.rawLength],
  );
}

/** Default cache expiry: 7 days. */
const CACHE_EXPIRY_DAYS = 7;

/**
 * Delete cache entries older than the expiry period.
 * Returns the number of rows deleted.
 */
export async function expireBrowseCache(expiryDays = CACHE_EXPIRY_DAYS): Promise<number> {
  await ensureTable();
  const p = getPool();
  const result = await p.query(
    `DELETE FROM browse_cache WHERE scraped_at < NOW() - INTERVAL '1 day' * $1`,
    [expiryDays],
  );
  return result.rowCount ?? 0;
}

/**
 * Delete cache entries for tasks that have been cleaned up (completed/failed/cancelled).
 * Call this alongside task cleanup to keep the cache in sync.
 * Returns the number of rows deleted.
 */
export async function cleanupBrowseCache(): Promise<number> {
  await ensureTable();
  const p = getPool();
  // Delete cache for tasks that no longer exist in the task table
  const result = await p.query(`
    DELETE FROM browse_cache
    WHERE task_id NOT IN (SELECT task_id::text FROM absurd.t_default)
  `);
  return result.rowCount ?? 0;
}

/** Close the connection pool. */
export async function closeBrowseCache(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    tableInitialized = false;
  }
}
