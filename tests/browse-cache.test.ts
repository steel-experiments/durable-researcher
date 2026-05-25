// ABOUTME: Integration tests for browse_cache — defensive filter on read and purge of dead entries.
// ABOUTME: Talks to the real Postgres dev DB (the same one the CLI uses); cleans up after itself.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getCachedBrowse,
  setCachedBrowse,
  purgeNonMeaningfulCacheEntries,
  resetBrowseCacheState,
} from "../src/browse-cache.js";
import { getDbPool, closeDbPool } from "../src/db-pool.js";

const TEST_TASK_ID = "test-task-browse-cache-7f4a9c";

/**
 * Make a payload that passes isContentMeaningful (≥200 chars, ≥50 words, ≥0.2 uniqueness).
 */
function meaningfulContent(): { title: string; content: string; rawLength: number } {
  // 60 distinct short words → comfortably above 50-word threshold with high uniqueness.
  const words = [
    "lora", "low", "rank", "adaptation", "method", "transformer", "layer", "weight",
    "freeze", "matrix", "training", "parameters", "efficient", "tuning", "model",
    "decompose", "rank", "factor", "neurips", "iclr", "paper", "results", "benchmark",
    "improve", "memory", "throughput", "accuracy", "table", "figure", "appendix",
    "concrete", "verbatim", "quote", "section", "experiment", "ablation", "setup",
    "compare", "baseline", "previous", "follow", "recent", "extend", "discuss",
    "future", "limitation", "future", "open", "question", "evaluation",
    "diverse", "metric", "summary", "abstract", "introduction", "related", "work",
    "approach", "discussion", "conclusion",
  ];
  const content = words.join(" ") + ".";
  return { title: "Test page", content, rawLength: content.length };
}

describe("browse-cache integration", () => {
  beforeAll(async () => {
    // Ensure the table exists by triggering a benign read.
    await getCachedBrowse(TEST_TASK_ID, "https://example.com/__init__").catch(() => null);
  });

  afterAll(async () => {
    const pool = getDbPool();
    await pool.query(`DELETE FROM browse_cache WHERE task_id = $1`, [TEST_TASK_ID]);
    await closeDbPool();
    resetBrowseCacheState();
  });

  beforeEach(async () => {
    const pool = getDbPool();
    await pool.query(`DELETE FROM browse_cache WHERE task_id = $1`, [TEST_TASK_ID]);
  });

  it("returns the row for meaningful cached content", async () => {
    const payload = meaningfulContent();
    await setCachedBrowse(TEST_TASK_ID, "https://example.com/ok", payload);
    const got = await getCachedBrowse(TEST_TASK_ID, "https://example.com/ok");
    expect(got).not.toBeNull();
    expect(got!.content).toBe(payload.content);
  });

  it("treats a stale dead row as a cache miss on read", async () => {
    // Simulate a polluted row from before the agent learned to skip dead pages.
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO browse_cache (task_id, url, title, content, raw_length)
       VALUES ($1, $2, $3, $4, $5)`,
      [TEST_TASK_ID, "https://example.com/blocked", "Blocked", "Login | Sign up", 16],
    );
    const got = await getCachedBrowse(TEST_TASK_ID, "https://example.com/blocked");
    expect(got).toBeNull();
  });

  it("purgeNonMeaningfulCacheEntries removes dead rows but keeps meaningful ones", async () => {
    const pool = getDbPool();
    // Dead — empty content
    await pool.query(
      `INSERT INTO browse_cache (task_id, url, title, content, raw_length)
       VALUES ($1, $2, $3, $4, $5)`,
      [TEST_TASK_ID, "https://example.com/empty", "Empty", "", 0],
    );
    // Dead — short raw_length
    await pool.query(
      `INSERT INTO browse_cache (task_id, url, title, content, raw_length)
       VALUES ($1, $2, $3, $4, $5)`,
      [TEST_TASK_ID, "https://example.com/short", "Short", "tiny", 4],
    );
    // Alive — meaningful
    const ok = meaningfulContent();
    await setCachedBrowse(TEST_TASK_ID, "https://example.com/alive", ok);

    const deleted = await purgeNonMeaningfulCacheEntries();
    expect(deleted).toBeGreaterThanOrEqual(2);

    const empty = await pool.query(
      `SELECT count(*)::int AS c FROM browse_cache WHERE task_id = $1 AND url = $2`,
      [TEST_TASK_ID, "https://example.com/empty"],
    );
    const short = await pool.query(
      `SELECT count(*)::int AS c FROM browse_cache WHERE task_id = $1 AND url = $2`,
      [TEST_TASK_ID, "https://example.com/short"],
    );
    const alive = await pool.query(
      `SELECT count(*)::int AS c FROM browse_cache WHERE task_id = $1 AND url = $2`,
      [TEST_TASK_ID, "https://example.com/alive"],
    );
    expect(empty.rows[0].c).toBe(0);
    expect(short.rows[0].c).toBe(0);
    expect(alive.rows[0].c).toBe(1);
  });
});
