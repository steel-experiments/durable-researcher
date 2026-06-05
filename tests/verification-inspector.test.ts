// ABOUTME: Tests for the --show-verification helper — formatting + DB lookup.
// ABOUTME: Pure-function tests don't touch the DB; the loader test uses the live dev DB.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  formatVerificationCheckpoint,
  loadVerificationCheckpoints,
  type VerificationCheckpoint,
} from "../src/verification-inspector.js";
import { closeDbPool, getDbPool } from "../src/db-pool.js";
import type { VerificationResult } from "../src/tools/verify-claims.js";

const TEST_QUEUE = `cli_test_inspect_${Math.floor(Date.now() / 1000)}`;

function makeResult(
  supported: number,
  total: number,
  claimsOverride?: VerificationResult["claims"],
): VerificationResult {
  const claims: VerificationResult["claims"] =
    claimsOverride ??
    Array.from({ length: total }, (_, i) => ({
      claim: `Claim ${i + 1}.`,
      sourceNs: [i + 1],
      sourceUrls: [`https://src${i + 1}.com`],
      supported: i < supported,
      reason: i < supported ? "matches" : "no excerpt",
    }));
  return {
    claims,
    summary: {
      total,
      supported,
      unsupported: total - supported,
      passRate: total === 0 ? 0 : supported / total,
      status: total === 0 ? "no_claims" : supported / total >= 0.7 ? "passed" : "failed",
      ...(total === 0 ? { reason: "No parseable numeric inline citations were found in the report body" } : {}),
    },
  };
}

describe("formatVerificationCheckpoint", () => {
  it("renders attempt header with pass-rate percentage", () => {
    const out = formatVerificationCheckpoint({ attempt: 2, result: makeResult(7, 10) });
    expect(out).toContain("Attempt 2");
    expect(out).toContain("7/10 supported (70%)");
  });

  it("groups unsupported claims with their reason and cited URL", () => {
    const out = formatVerificationCheckpoint({ attempt: 1, result: makeResult(0, 2) });
    expect(out).toContain("UNSUPPORTED (2)");
    expect(out).toContain("✗ [1]");
    expect(out).toContain("cited: https://src1.com");
    expect(out).toContain("reason: no excerpt");
  });

  it("lists supported claims with check marks", () => {
    const out = formatVerificationCheckpoint({ attempt: 1, result: makeResult(2, 2) });
    expect(out).toContain("SUPPORTED (2)");
    expect(out).toContain("✓ [1]");
    expect(out).toContain("✓ [2]");
    expect(out).not.toContain("UNSUPPORTED");
  });

  it("truncates long claim text", () => {
    const longClaim = "x".repeat(500);
    const result = makeResult(0, 1, [
      { claim: longClaim, sourceNs: [1], sourceUrls: ["u"], supported: false, reason: "n/a" },
    ]);
    const out = formatVerificationCheckpoint({ attempt: 1, result });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(longClaim.length + 200);
  });
});

const describeDb = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

describeDb("loadVerificationCheckpoints (integration)", () => {
  let createdQueue = false;
  const taskId = "00000000-0000-0000-0000-00000000beef";

  beforeAll(async () => {
    const pool = getDbPool();
    await pool.query(`SELECT absurd.create_queue($1)`, [TEST_QUEUE]);
    createdQueue = true;

    // Stage a fake task + two committed verify-claims checkpoints.
    await pool.query(
      `INSERT INTO absurd.${'"' + `t_${TEST_QUEUE}` + '"'}
         (task_id, task_name, params, enqueue_at, state, attempts)
       VALUES ($1, 'research', '{"topic":"inspector test"}'::jsonb, now(), 'completed', 1)`,
      [taskId],
    );
    const r1 = makeResult(5, 10);
    const r2 = makeResult(8, 10);
    await pool.query(
      `INSERT INTO absurd.${'"' + `c_${TEST_QUEUE}` + '"'}
         (task_id, checkpoint_name, state, status)
       VALUES ($1, 'verify-claims-attempt-1', $2::jsonb, 'committed'),
              ($1, 'verify-claims-attempt-2', $3::jsonb, 'committed')`,
      [taskId, JSON.stringify(r1), JSON.stringify(r2)],
    );
  });

  afterAll(async () => {
    if (createdQueue) {
      const pool = getDbPool();
      try {
        await pool.query(`SELECT absurd.drop_queue($1)`, [TEST_QUEUE]);
      } catch {
        // best-effort
      }
    }
    await closeDbPool();
  });

  it("returns checkpoints sorted by attempt number", async () => {
    const checkpoints = await loadVerificationCheckpoints(taskId, TEST_QUEUE);
    expect(checkpoints.map((c) => c.attempt)).toEqual([1, 2]);
    expect(checkpoints[0].result.summary.supported).toBe(5);
    expect(checkpoints[1].result.summary.supported).toBe(8);
  });

  it("returns empty for tasks with no verification checkpoints", async () => {
    const checkpoints = await loadVerificationCheckpoints(
      "00000000-0000-0000-0000-deadbeefdead",
      TEST_QUEUE,
    );
    expect(checkpoints).toEqual([]);
  });
});
