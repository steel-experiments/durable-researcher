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
