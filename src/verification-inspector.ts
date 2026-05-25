// ABOUTME: Pretty-print the per-claim verdicts stored in a task's verify-claims-attempt-N
// ABOUTME: checkpoint. Used by the `--show-verification` CLI flag to make "shipped at 70%"
// ABOUTME: reports auditable: list which specific claims passed, which failed, and why.

import { getDbPool } from "./db-pool.js";
import { findTaskById } from "./task-finder.js";
import type { VerificationResult } from "./tools/verify-claims.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

export type VerificationCheckpoint = {
  attempt: number;
  result: VerificationResult;
};

/**
 * Load every committed `verify-claims-attempt-N` checkpoint for a task, sorted by N.
 * Returns an empty array if the task has no verifications yet.
 */
export async function loadVerificationCheckpoints(
  taskId: string,
  queueName: string,
): Promise<VerificationCheckpoint[]> {
  const pool = getDbPool();
  const checkpointsTable = quoteIdent(`c_${queueName}`);
  const result = await pool.query<{ checkpoint_name: string; state: unknown }>(
    `SELECT checkpoint_name, state
       FROM absurd.${checkpointsTable}
      WHERE task_id = $1
        AND status = 'committed'
        AND checkpoint_name LIKE 'verify-claims-attempt-%'
      ORDER BY checkpoint_name`,
    [taskId],
  );

  const out: VerificationCheckpoint[] = [];
  for (const row of result.rows) {
    const attempt = Number.parseInt(
      row.checkpoint_name.replace("verify-claims-attempt-", ""),
      10,
    );
    if (!Number.isFinite(attempt)) continue;
    // The step result is stored as a JSONB blob matching VerificationResult.
    out.push({ attempt, result: row.state as VerificationResult });
  }
  // Sort numerically; lexicographic order breaks at attempt-10+.
  out.sort((a, b) => a.attempt - b.attempt);
  return out;
}

/** Format a single VerificationCheckpoint into a human-readable block. */
export function formatVerificationCheckpoint(
  checkpoint: VerificationCheckpoint,
): string {
  const { attempt, result } = checkpoint;
  const { summary, claims } = result;
  const passRatePct = (summary.passRate * 100).toFixed(0);

  const lines: string[] = [
    `── Attempt ${attempt} — ${summary.supported}/${summary.total} supported (${passRatePct}%)`,
    "",
  ];

  const supported = claims.filter((c) => c.supported);
  const unsupported = claims.filter((c) => !c.supported);

  if (unsupported.length > 0) {
    lines.push(`UNSUPPORTED (${unsupported.length}):`);
    for (const c of unsupported) {
      const claimPreview = c.claim.replace(/\s+/g, " ").trim().slice(0, 140);
      const truncated = c.claim.length > 140 ? "…" : "";
      lines.push(`  ✗ [${c.sourceN}] ${claimPreview}${truncated}`);
      lines.push(`      cited: ${c.sourceUrl ?? "(no URL)"}`);
      lines.push(`      reason: ${c.reason}`);
      lines.push("");
    }
  }

  if (supported.length > 0) {
    lines.push(`SUPPORTED (${supported.length}):`);
    for (const c of supported) {
      const claimPreview = c.claim.replace(/\s+/g, " ").trim().slice(0, 100);
      const truncated = c.claim.length > 100 ? "…" : "";
      lines.push(`  ✓ [${c.sourceN}] ${claimPreview}${truncated}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Top-level handler for `--show-verification <task-id>`. Resolves the task, loads all
 * committed verification checkpoints, and writes a pretty-printed report to the given
 * sink (defaults to console.log so the CLI uses it directly).
 */
export async function showVerification(
  taskId: string,
  write: (line: string) => void = console.log,
): Promise<void> {
  const task = await findTaskById(taskId);
  if (!task) {
    write(`Error: task ${taskId} not found.`);
    return;
  }

  const checkpoints = await loadVerificationCheckpoints(taskId, task.queueName);
  if (checkpoints.length === 0) {
    write(`Task ${taskId} ("${task.topic}") has no verification checkpoints.`);
    write(`  Status: ${task.status}`);
    write(`  Verification only runs after the agent produces a citable report.`);
    return;
  }

  write(`Task: ${taskId}`);
  write(`Topic: "${task.topic}"`);
  write(`Status: ${task.status}`);
  write(`Verification attempts: ${checkpoints.length}`);
  write("");

  for (const checkpoint of checkpoints) {
    write(formatVerificationCheckpoint(checkpoint));
  }

  // Final summary line — useful for grep / scripting.
  const last = checkpoints[checkpoints.length - 1];
  const lastPct = (last.result.summary.passRate * 100).toFixed(0);
  write(
    `Final: attempt ${last.attempt} — ${last.result.summary.supported}/${last.result.summary.total} supported (${lastPct}%).`,
  );
}
