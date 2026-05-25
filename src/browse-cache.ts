// ABOUTME: Postgres-backed cache for scraped page content keyed by (task_id, url).
// ABOUTME: Prevents re-scraping on crash/resume and benefits extend mode across tasks.

import { getDbPool } from "./db-pool.js";
import { isContentMeaningful } from "./content.js";

export type CachedBrowse = {
  url: string;
  title: string;
  content: string;
  rawLength: number;
  scrapedAt: Date;
};

let tableInitialized = false;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

/** Create the browse_cache table if it doesn't exist. */
async function ensureTable(): Promise<void> {
  if (tableInitialized) return;
  const p = getDbPool();
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

/**
 * Look up a cached browse result for a given task and URL. Returns null if the cached
 * content fails meaningfulness — old rows written by versions before the agent learned
 * to skip dead pages get treated as cache misses so the caller refetches.
 */
export async function getCachedBrowse(
  taskId: string,
  url: string,
): Promise<CachedBrowse | null> {
  await ensureTable();
  const p = getDbPool();
  const result = await p.query(
    `SELECT url, title, content, raw_length, scraped_at FROM browse_cache WHERE task_id = $1 AND url = $2`,
    [taskId, url],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (typeof row.content !== "string" || !isContentMeaningful(row.content)) {
    return null;
  }
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
  const p = getDbPool();
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
  const p = getDbPool();
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
  const p = getDbPool();
  const queuesResult = await p.query<{ queue_name: string }>(
    `SELECT queue_name FROM absurd.list_queues()`,
  );
  const queueNames = queuesResult.rows.map((row) => row.queue_name);

  if (queueNames.length === 0) {
    const result = await p.query(`DELETE FROM browse_cache`);
    return result.rowCount ?? 0;
  }

  const liveTaskSelects = queueNames.map((queueName) => {
    const tableName = `absurd.${quoteIdent(`t_${queueName}`)}`;
    return `SELECT task_id::text AS task_id FROM ${tableName}`;
  });

  // Delete cache for tasks that no longer exist in any Absurd queue.
  const result = await p.query(`
    DELETE FROM browse_cache
    WHERE task_id NOT IN (${liveTaskSelects.join(" UNION ALL ")})
  `);
  return result.rowCount ?? 0;
}

/**
 * Look up cached page titles for a set of URLs (for a single task). Returns a map of
 * URL → title for entries that exist. Used to render meaningful source titles instead
 * of dumping URLs as titles in the final report's Sources section.
 */
export async function getTitlesForUrls(
  taskId: string,
  urls: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (urls.length === 0) return map;
  await ensureTable();
  const p = getDbPool();
  const result = await p.query<{ url: string; title: string | null }>(
    `SELECT url, title FROM browse_cache WHERE task_id = $1 AND url = ANY($2::text[])`,
    [taskId, urls],
  );
  for (const row of result.rows) {
    if (row.title && row.title.trim().length > 0 && row.title !== row.url) {
      map.set(row.url, row.title.trim());
    }
  }
  return map;
}

/**
 * Delete cache rows whose content was too thin to be meaningful (bot blocks, empty
 * scrapes, paywalled stubs). Uses a simple length-based heuristic at the SQL level —
 * matches the lower bound of `isContentMeaningful`. Run this once after upgrading to a
 * version that stops caching such pages, to clean out polluted rows from earlier runs.
 *
 * Returns the number of rows deleted.
 */
export async function purgeNonMeaningfulCacheEntries(): Promise<number> {
  await ensureTable();
  const p = getDbPool();
  // 200 chars matches isContentMeaningful's `minLength`. Rows with NULL content are
  // also dead. A row that passes this filter may still be uninteresting, but those are
  // judgment calls the agent makes per-run — only purge the certain-dead ones here.
  const result = await p.query(
    `DELETE FROM browse_cache
     WHERE content IS NULL
        OR length(content) < 200
        OR raw_length IS NULL
        OR raw_length < 200`,
  );
  return result.rowCount ?? 0;
}

/** Reset the table-initialized flag. The shared pool itself is owned by db-pool.ts. */
export function resetBrowseCacheState(): void {
  tableInitialized = false;
}
