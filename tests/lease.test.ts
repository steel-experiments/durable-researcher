// ABOUTME: Tests for lease-detection helpers (workerId parsing, dead-PID detection).
// ABOUTME: Database-touching paths covered by the live-DB integration block below.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as os from "os";
import {
  defaultWorkerId,
  isPidDead,
  parseWorkerId,
  listOrphanCandidates,
  reapOrphanedTasks,
  reapOrphanedTasksAllQueues,
} from "../src/lease.js";
import { closeDbPool, getDbPool } from "../src/db-pool.js";

describe("parseWorkerId", () => {
  it("splits `hostname:pid` into host and pid", () => {
    expect(parseWorkerId("MacBook-Pro.local:12345")).toEqual({
      host: "MacBook-Pro.local",
      pid: 12345,
    });
  });

  it("uses the last colon so hostnames containing colons round-trip", () => {
    expect(parseWorkerId("ip6:colon:host:42")).toEqual({
      host: "ip6:colon:host",
      pid: 42,
    });
  });

  it("returns null for missing or empty input", () => {
    expect(parseWorkerId(null)).toBeNull();
    expect(parseWorkerId("")).toBeNull();
  });

  it("returns null when there is no colon", () => {
    expect(parseWorkerId("just-a-host")).toBeNull();
  });

  it("returns null when the pid is not a positive integer", () => {
    expect(parseWorkerId("host:abc")).toBeNull();
    expect(parseWorkerId("host:0")).toBeNull();
    expect(parseWorkerId("host:-1")).toBeNull();
  });
});

describe("isPidDead", () => {
  it("returns false for the current process", () => {
    expect(isPidDead(process.pid)).toBe(false);
  });

  it("returns true for a PID that cannot exist (very high)", () => {
    // PIDs on macOS/Linux max out below 4_194_304; this one will not exist.
    expect(isPidDead(4_194_303)).toBe(true);
  });
});

describe("defaultWorkerId", () => {
  it("matches the absurd-sdk convention `${hostname}:${pid}`", () => {
    expect(defaultWorkerId()).toBe(`${os.hostname()}:${process.pid}`);
  });
});

/**
 * Live-DB integration: spins up a dedicated queue, inserts a fake orphaned task that
 * looks like a dead worker died mid-run, and verifies the reaper marks it as failed.
 *
 * Uses absurd.create_queue + raw SQL inserts to avoid pulling in the full Absurd SDK
 * for what's really a per-row state-transition test.
 */
describe("reapOrphanedTasks (integration)", () => {
  const queue = `cli_test_reap_${Math.floor(Date.now() / 1000)}`;
  let createdQueue = false;

  beforeAll(async () => {
    const pool = getDbPool();
    await pool.query(`SELECT absurd.create_queue($1)`, [queue]);
    createdQueue = true;
  });

  afterAll(async () => {
    if (createdQueue) {
      const pool = getDbPool();
      try {
        await pool.query(`SELECT absurd.drop_queue($1)`, [queue]);
      } catch {
        // best-effort cleanup
      }
    }
    await closeDbPool();
  });

  function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, "\"\"")}"`;
  }

  async function insertOrphan(opts: {
    claimedBy: string;
    leaseExpiredMinutesAgo?: number;
  }): Promise<{ taskId: string; runId: string }> {
    const pool = getDbPool();
    const taskId = await pool.query<{ id: string }>(
      `INSERT INTO absurd.${quoteIdent(`t_${queue}`)}
         (task_id, task_name, params, enqueue_at, first_started_at, state, attempts)
       VALUES
         (gen_random_uuid(), 'research', '{"topic":"orphan"}'::jsonb, now() - interval '10 minutes',
          now() - interval '10 minutes', 'running', 1)
       RETURNING task_id::text AS id`,
    );
    const ago = opts.leaseExpiredMinutesAgo ?? 5;
    const runId = await pool.query<{ id: string }>(
      `INSERT INTO absurd.${quoteIdent(`r_${queue}`)}
         (run_id, task_id, attempt, state, claimed_by, claim_expires_at,
          available_at, started_at, created_at)
       VALUES
         (gen_random_uuid(), $1, 1, 'running', $2,
          now() - interval '${ago} minutes', now() - interval '10 minutes',
          now() - interval '10 minutes', now() - interval '10 minutes')
       RETURNING run_id::text AS id`,
      [taskId.rows[0].id, opts.claimedBy],
    );
    return { taskId: taskId.rows[0].id, runId: runId.rows[0].id };
  }

  it("lists running rows with expired leases", async () => {
    await insertOrphan({ claimedBy: `${os.hostname()}:999999` });
    const candidates = await listOrphanCandidates(queue);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("reaps an orphan whose holder PID is dead on this host", async () => {
    const { taskId } = await insertOrphan({
      claimedBy: `${os.hostname()}:4194303`, // PID beyond max — guaranteed dead
    });

    const results = await reapOrphanedTasks(queue);
    const reaped = results.find((r) => r.taskId === taskId);
    expect(reaped).toBeDefined();
    expect(reaped!.reaped).toBe(true);
    expect(reaped!.reason).toBe("holder-dead");

    // Confirm DB state flipped to failed
    const pool = getDbPool();
    const taskRow = await pool.query<{ state: string }>(
      `SELECT state FROM absurd.${quoteIdent(`t_${queue}`)} WHERE task_id = $1`,
      [taskId],
    );
    expect(taskRow.rows[0].state).toBe("failed");
  });

  it("skips orphans claimed by another host", async () => {
    const { taskId } = await insertOrphan({
      claimedBy: `some-other-host.local:42`,
    });

    const results = await reapOrphanedTasks(queue);
    const entry = results.find((r) => r.taskId === taskId);
    expect(entry).toBeDefined();
    expect(entry!.reaped).toBe(false);
    expect(entry!.reason).toBe("different-host");

    const pool = getDbPool();
    const taskRow = await pool.query<{ state: string }>(
      `SELECT state FROM absurd.${quoteIdent(`t_${queue}`)} WHERE task_id = $1`,
      [taskId],
    );
    expect(taskRow.rows[0].state).toBe("running");
  });

  it("skips orphans whose holder PID is still alive on this host", async () => {
    const { taskId } = await insertOrphan({
      claimedBy: `${os.hostname()}:${process.pid}`,
    });

    const results = await reapOrphanedTasks(queue);
    const entry = results.find((r) => r.taskId === taskId);
    expect(entry).toBeDefined();
    expect(entry!.reaped).toBe(false);
    expect(entry!.reason).toBe("holder-alive");

    const pool = getDbPool();
    const taskRow = await pool.query<{ state: string }>(
      `SELECT state FROM absurd.${quoteIdent(`t_${queue}`)} WHERE task_id = $1`,
      [taskId],
    );
    expect(taskRow.rows[0].state).toBe("running");
  });

  it("reapOrphanedTasksAllQueues sweeps across queues without erroring", async () => {
    await insertOrphan({ claimedBy: `${os.hostname()}:4194302` });
    const results = await reapOrphanedTasksAllQueues();
    expect(Array.isArray(results)).toBe(true);
  });
});
