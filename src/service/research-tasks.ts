// ABOUTME: Persistence helpers for task-level work units inside a ResearchRun.
// ABOUTME: Gives single-agent, fixed-team, and subagent harnesses a shared ledger.

import { randomUUID } from "node:crypto";
import { getDbPool } from "../db-pool.js";
import type { CampaignUsage, ResearchResult } from "../types.js";

let schemaReady = false;

export type ResearchRunTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ResearchRunTask = {
  id: string;
  runId: string;
  role: string;
  harnessType: string;
  taskId: string | null;
  queueName: string | null;
  status: ResearchRunTaskStatus;
  objective: string;
  result: ResearchResult | null;
  usage: CampaignUsage | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
};

type ResearchRunTaskRow = {
  id: string;
  run_id: string;
  role: string;
  harness_type: string;
  task_id: string | null;
  queue_name: string | null;
  status: ResearchRunTaskStatus;
  objective: string;
  result: ResearchResult | null;
  usage: CampaignUsage | null;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
};

function rowToTask(row: ResearchRunTaskRow): ResearchRunTask {
  return {
    id: row.id,
    runId: row.run_id,
    role: row.role,
    harnessType: row.harness_type,
    taskId: row.task_id,
    queueName: row.queue_name,
    status: row.status,
    objective: row.objective,
    result: row.result,
    usage: row.usage,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

export async function ensureResearchTaskSchema(): Promise<void> {
  if (schemaReady) return;
  await getDbPool().query(`
    CREATE TABLE IF NOT EXISTS research_run_tasks (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
      role text NOT NULL,
      harness_type text NOT NULL,
      task_id text,
      queue_name text,
      status text NOT NULL,
      objective text NOT NULL,
      result jsonb,
      usage jsonb,
      started_at timestamptz,
      ended_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  schemaReady = true;
}

export async function createResearchRunTask(input: {
  runId: string;
  role: string;
  harnessType: string;
  objective: string;
  status?: ResearchRunTaskStatus;
}): Promise<ResearchRunTask> {
  await ensureResearchTaskSchema();
  const id = `task_${randomUUID()}`;
  const result = await getDbPool().query(
    `INSERT INTO research_run_tasks
       (id, run_id, role, harness_type, status, objective)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, input.runId, input.role, input.harnessType, input.status ?? "queued", input.objective],
  );
  return rowToTask(result.rows[0]);
}

export async function updateResearchRunTask(
  id: string,
  patch: {
    taskId?: string | null;
    queueName?: string | null;
    status?: ResearchRunTaskStatus;
    result?: ResearchResult | null;
    usage?: CampaignUsage | null;
    startedAt?: Date | null;
    endedAt?: Date | null;
  },
): Promise<ResearchRunTask> {
  await ensureResearchTaskSchema();
  const result = await getDbPool().query(
    `UPDATE research_run_tasks
        SET task_id = COALESCE($2, task_id),
            queue_name = COALESCE($3, queue_name),
            status = COALESCE($4, status),
            result = COALESCE($5, result),
            usage = COALESCE($6, usage),
            started_at = COALESCE($7, started_at),
            ended_at = COALESCE($8, ended_at)
      WHERE id = $1
      RETURNING *`,
    [
      id,
      patch.taskId ?? null,
      patch.queueName ?? null,
      patch.status ?? null,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.usage ? JSON.stringify(patch.usage) : null,
      patch.startedAt ?? null,
      patch.endedAt ?? null,
    ],
  );
  return rowToTask(result.rows[0]);
}

export async function listResearchRunTasks(runId: string): Promise<ResearchRunTask[]> {
  await ensureResearchTaskSchema();
  const result = await getDbPool().query(
    `SELECT * FROM research_run_tasks WHERE run_id = $1 ORDER BY created_at ASC`,
    [runId],
  );
  return result.rows.map(rowToTask);
}
