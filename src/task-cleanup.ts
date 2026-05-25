// ABOUTME: CLI --cleanup implementation: delete completed/failed/cancelled tasks across all queues
// ABOUTME: and tidy up the browse cache. Uses the shared db-pool.

import { getDbPool } from "./db-pool.js";
import {
  cleanupBrowseCache,
  expireBrowseCache,
  purgeNonMeaningfulCacheEntries,
} from "./browse-cache.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

/** Delete terminal-state tasks across all queues, drop empty CLI queues, and tidy the browse cache. */
export async function cleanupTasks(): Promise<void> {
  const pool = getDbPool();
  const queuesResult = await pool.query(`SELECT queue_name FROM absurd.list_queues()`);
  let deletedTasks = 0;

  for (const row of queuesResult.rows as Array<{ queue_name: string }>) {
    const queue = row.queue_name;
    const tasksTable = `absurd.${quoteIdent(`t_${queue}`)}`;
    const checkpointsTable = `absurd.${quoteIdent(`c_${queue}`)}`;
    const waitersTable = `absurd.${quoteIdent(`w_${queue}`)}`;
    const runsTable = `absurd.${quoteIdent(`r_${queue}`)}`;

    // Delete checkpoints, waiters, runs, and events for terminal tasks, then the tasks themselves
    await pool.query(`
      DELETE FROM ${checkpointsTable}
      WHERE task_id IN (
        SELECT task_id FROM ${tasksTable}
        WHERE state IN ('completed', 'failed', 'cancelled')
      )
    `);
    await pool.query(`
      DELETE FROM ${waitersTable}
      WHERE task_id IN (
        SELECT task_id FROM ${tasksTable}
        WHERE state IN ('completed', 'failed', 'cancelled')
      )
    `);
    await pool.query(`
      DELETE FROM ${runsTable}
      WHERE task_id IN (
        SELECT task_id FROM ${tasksTable}
        WHERE state IN ('completed', 'failed', 'cancelled')
      )
    `);
    const deleted = await pool.query(`
      DELETE FROM ${tasksTable}
      WHERE state IN ('completed', 'failed', 'cancelled')
      RETURNING task_id
    `);
    deletedTasks += deleted.rowCount ?? 0;

    // Per-run CLI queues are ephemeral; remove them once empty.
    if (queue.startsWith("cli_")) {
      const remaining = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${tasksTable}`);
      if (remaining.rows[0]?.count === "0") {
        await pool.query(`SELECT absurd.drop_queue($1)`, [queue]);
      }
    }
  }

  console.log(`Cleaned up ${deletedTasks} tasks.`);

  // Clean up browse cache: remove entries for deleted tasks + expire old entries +
  // drop the dead (bot-blocked / empty / paywalled) rows that bloated the cache before
  // the agent learned to skip writing them.
  const cacheOrphans = await cleanupBrowseCache();
  const cacheExpired = await expireBrowseCache();
  const cacheDead = await purgeNonMeaningfulCacheEntries();
  if (cacheOrphans > 0 || cacheExpired > 0 || cacheDead > 0) {
    console.log(
      `Browse cache: ${cacheOrphans} orphaned + ${cacheExpired} expired + ${cacheDead} non-meaningful entries removed.`,
    );
  }
}
