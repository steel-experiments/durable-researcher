// ABOUTME: Inspect and release Absurd run leases so an interrupted process can be resumed immediately.
// ABOUTME: Used on graceful exit (release own) and on resume (clear stale lease held by a dead PID).

import * as os from "os";
import { getDbPool } from "./db-pool.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

export type LeaseInfo = {
  runId: string;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  secondsRemaining: number | null;
};

/** Read the active running run row for `taskId` on `queueName`, if any. */
export async function getRunningLease(
  taskId: string,
  queueName: string,
): Promise<LeaseInfo | null> {
  const pool = getDbPool();
  const table = quoteIdent(`r_${queueName}`);
  try {
    const result = await pool.query(
      `SELECT run_id, claimed_by, claim_expires_at,
         EXTRACT(EPOCH FROM (claim_expires_at - now()))::int AS seconds_remaining
       FROM absurd.${table}
       WHERE task_id = $1 AND state = 'running'
       LIMIT 1`,
      [taskId],
    );
    const row = result.rows[0] as
      | {
          run_id: string;
          claimed_by: string | null;
          claim_expires_at: Date | null;
          seconds_remaining: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      claimedBy: row.claimed_by,
      claimExpiresAt: row.claim_expires_at,
      secondsRemaining: row.seconds_remaining,
    };
  } catch (err) {
    // Missing per-queue table (e.g. queue dropped) — treat as no lease.
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
}

/**
 * Parse `hostname:pid` worker IDs (the format absurd-sdk uses by default).
 * The hostname itself may contain colons on some systems, so split on the last one.
 */
export function parseWorkerId(
  workerId: string | null,
): { host: string; pid: number } | null {
  if (!workerId) return null;
  const lastColon = workerId.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const host = workerId.slice(0, lastColon);
  const pidStr = workerId.slice(lastColon + 1);
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid) || pid <= 0) return null;
  return { host, pid };
}

/** True iff `pid` is no longer running on the current host. */
export function isPidDead(pid: number): boolean {
  try {
    // signal 0 doesn't deliver — it only probes. ESRCH means no such process.
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The workerId absurd-sdk synthesizes by default when none is provided. */
export function defaultWorkerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

export type ClearReason =
  | "no-running-run"
  | "no-lease"
  | "different-host"
  | "holder-alive"
  | "holder-dead"
  | "self"
  | "forced";

export type ClearResult = {
  cleared: boolean;
  reason: ClearReason;
  lease: LeaseInfo | null;
};

export type OrphanCandidate = {
  taskId: string;
  runId: string;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
};

export type OrphanReapResult = {
  taskId: string;
  runId: string;
  reaped: boolean;
  /** Why we did (or did not) reap this orphan. */
  reason: "holder-dead" | "different-host" | "holder-alive" | "no-lease" | "error";
  error?: string;
};

/**
 * List running-task rows whose lease has already expired. Inspect-only — does not
 * mutate state. The reap pass narrows these candidates down by holder host + PID.
 */
export async function listOrphanCandidates(
  queueName: string,
): Promise<OrphanCandidate[]> {
  const pool = getDbPool();
  const runsTable = quoteIdent(`r_${queueName}`);
  const tasksTable = quoteIdent(`t_${queueName}`);
  try {
    const result = await pool.query(
      `SELECT r.task_id::text AS task_id,
              r.run_id::text  AS run_id,
              r.claimed_by    AS claimed_by,
              r.claim_expires_at AS claim_expires_at
         FROM absurd.${runsTable} r
         JOIN absurd.${tasksTable} t ON t.task_id = r.task_id
        WHERE r.state = 'running'
          AND t.state = 'running'
          AND r.claim_expires_at IS NOT NULL
          AND r.claim_expires_at < now()`,
    );
    return (result.rows as Array<{
      task_id: string;
      run_id: string;
      claimed_by: string | null;
      claim_expires_at: Date | null;
    }>).map((row) => ({
      taskId: row.task_id,
      runId: row.run_id,
      claimedBy: row.claimed_by,
      claimExpiresAt: row.claim_expires_at,
    }));
  } catch (err) {
    // Missing per-queue table (e.g. queue dropped) — treat as no orphans.
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
}

/**
 * Reap orphaned running tasks whose worker died without releasing the lease. A task is
 * orphaned when its lease has expired AND the holder process (on this host) is dead.
 * Failed reap candidates (holder on another host, or holder still alive) are skipped.
 *
 * Marks both the run row and the task row as `failed` so subsequent `--cleanup` removes
 * them. Without this sweep, a worker that crashes leaves the task forever stuck in
 * `state='running'` (the lease-clear in clearStaleLease only fires on `--resume`).
 */
export async function reapOrphanedTasks(
  queueName: string,
): Promise<OrphanReapResult[]> {
  const candidates = await listOrphanCandidates(queueName);
  if (candidates.length === 0) return [];

  const pool = getDbPool();
  const runsTable = quoteIdent(`r_${queueName}`);
  const tasksTable = quoteIdent(`t_${queueName}`);
  const ourHost = os.hostname();
  const results: OrphanReapResult[] = [];

  for (const candidate of candidates) {
    const holder = parseWorkerId(candidate.claimedBy);
    if (!candidate.claimedBy || !holder) {
      results.push({
        taskId: candidate.taskId,
        runId: candidate.runId,
        reaped: false,
        reason: "no-lease",
      });
      continue;
    }
    if (holder.host !== ourHost) {
      results.push({
        taskId: candidate.taskId,
        runId: candidate.runId,
        reaped: false,
        reason: "different-host",
      });
      continue;
    }
    if (!isPidDead(holder.pid)) {
      results.push({
        taskId: candidate.taskId,
        runId: candidate.runId,
        reaped: false,
        reason: "holder-alive",
      });
      continue;
    }

    // Atomicity matters: if the run UPDATE commits but the task UPDATE fails
    // (network blip, pool timeout), the listOrphanCandidates JOIN — which
    // requires BOTH rows in state='running' — will never re-list this task,
    // permanently stranding it. Run both UPDATEs inside one transaction.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE absurd.${runsTable}
            SET state = 'failed',
                failed_at = now(),
                claim_expires_at = now() - interval '1 second',
                failure_reason = $2::jsonb
          WHERE run_id = $1 AND state = 'running'`,
        [candidate.runId, JSON.stringify({ kind: "orphaned", reason: "worker died without releasing lease" })],
      );
      await client.query(
        `UPDATE absurd.${tasksTable}
            SET state = 'failed'
          WHERE task_id = $1 AND state = 'running'`,
        [candidate.taskId],
      );
      await client.query("COMMIT");
      results.push({
        taskId: candidate.taskId,
        runId: candidate.runId,
        reaped: true,
        reason: "holder-dead",
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Connection may already be in an aborted state — ignore.
      }
      results.push({
        taskId: candidate.taskId,
        runId: candidate.runId,
        reaped: false,
        reason: "error",
        error: (err as Error).message,
      });
    } finally {
      client.release();
    }
  }

  return results;
}

/**
 * Sweep every Absurd queue for orphaned running tasks and reap them. Used at CLI
 * startup so a fresh run doesn't leave dead-worker tasks behind from earlier sessions.
 */
export async function reapOrphanedTasksAllQueues(): Promise<OrphanReapResult[]> {
  const pool = getDbPool();
  let queues: string[];
  try {
    const result = await pool.query<{ queue_name: string }>(
      `SELECT queue_name FROM absurd.list_queues()`,
    );
    queues = result.rows.map((row) => row.queue_name);
  } catch (err) {
    // No Absurd schema yet — nothing to sweep.
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }

  const all: OrphanReapResult[] = [];
  for (const queue of queues) {
    try {
      const reaped = await reapOrphanedTasks(queue);
      all.push(...reaped);
    } catch {
      // Skip on per-queue failure — best-effort sweep.
    }
  }
  return all;
}

/**
 * Clear the lease on the running run for `taskId`, but only when it is safe:
 *   - `force: true` — caller takes responsibility
 *   - the holder matches `currentWorkerId` (we are releasing our own lease)
 *   - the holder is on this hostname and its PID is dead
 *
 * Refuses when the holder is on another host or is still alive.
 */
export async function clearStaleLease(
  taskId: string,
  queueName: string,
  options: { force?: boolean; currentWorkerId?: string } = {},
): Promise<ClearResult> {
  const lease = await getRunningLease(taskId, queueName);
  if (!lease) return { cleared: false, reason: "no-running-run", lease: null };
  if (!lease.claimExpiresAt) return { cleared: false, reason: "no-lease", lease };

  const force = options.force === true;
  const isSelf = !!options.currentWorkerId && options.currentWorkerId === lease.claimedBy;
  const holder = parseWorkerId(lease.claimedBy);
  const ourHost = os.hostname();

  let reason: ClearReason;
  if (force) {
    reason = "forced";
  } else if (isSelf) {
    reason = "self";
  } else if (!holder || holder.host !== ourHost) {
    return { cleared: false, reason: "different-host", lease };
  } else if (!isPidDead(holder.pid)) {
    return { cleared: false, reason: "holder-alive", lease };
  } else {
    reason = "holder-dead";
  }

  const pool = getDbPool();
  const table = quoteIdent(`r_${queueName}`);
  await pool.query(
    `UPDATE absurd.${table}
        SET claim_expires_at = now() - interval '1 second'
      WHERE run_id = $1 AND state = 'running'`,
    [lease.runId],
  );
  return { cleared: true, reason, lease };
}
