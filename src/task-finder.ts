// ABOUTME: Finds existing research tasks for resume or deduplication.
// ABOUTME: Queries Postgres for recent tasks and uses LLM for fuzzy topic matching.

import type pg from "pg";
import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "./config.js";
import { getDbPool } from "./db-pool.js";

export type ExistingTask = {
  taskId: string;
  queueName: string;
  topic: string;
  status: string;
  createdAt: Date;
  attempt: number;
  maxAttempts: number;
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

async function listQueues(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query(`SELECT queue_name FROM absurd.list_queues()`);
  return result.rows.map((row: { queue_name: string }) => row.queue_name);
}

async function queryQueueTasks(
  pool: pg.Pool,
  queueName: string,
  limit: number,
): Promise<ExistingTask[]> {
  const tableName = quoteIdent(`t_${queueName}`);

  try {
    const result = await pool.query(
      `SELECT task_id, params, state, enqueue_at, attempts, max_attempts
       FROM absurd.${tableName}
       WHERE task_name = 'research'
       ORDER BY enqueue_at DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map((row: {
      task_id: string;
      params: { topic?: string };
      state: string;
      enqueue_at: Date;
      attempts: number;
      max_attempts: number | null;
    }) => ({
      taskId: row.task_id,
      queueName,
      topic: row.params?.topic ?? "unknown",
      status: row.state,
      createdAt: row.enqueue_at,
      attempt: row.attempts,
      maxAttempts: row.max_attempts ?? 3,
    }));
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") {
      return [];
    }
    throw error;
  }
}

/** Query Postgres for recent research tasks with their params. */
export async function findRecentTasks(
  limit = 20,
): Promise<ExistingTask[]> {
  const pool = getDbPool();
  const queues = await listQueues(pool);
  const taskGroups = await Promise.all(
    queues.map((queueName) => queryQueueTasks(pool, queueName, limit)),
  );

  return taskGroups
    .flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

/** Find a specific task ID across all queues. */
export async function findTaskById(
  taskId: string,
): Promise<ExistingTask | undefined> {
  const pool = getDbPool();
  const queues = await listQueues(pool);

  for (const queueName of queues) {
    const tableName = quoteIdent(`t_${queueName}`);
    try {
      const result = await pool.query(
        `SELECT task_id, params, state, enqueue_at, attempts, max_attempts
         FROM absurd.${tableName}
         WHERE task_id = $1
         LIMIT 1`,
        [taskId],
      );

      const row = result.rows[0] as {
        task_id: string;
        params: { topic?: string };
        state: string;
        enqueue_at: Date;
        attempts: number;
        max_attempts: number | null;
      } | undefined;

      if (row) {
        return {
          taskId: row.task_id,
          queueName,
          topic: row.params?.topic ?? "unknown",
          status: row.state,
          createdAt: row.enqueue_at,
          attempt: row.attempts,
          maxAttempts: row.max_attempts ?? 3,
        };
      }
    } catch (error) {
      if ((error as { code?: string }).code === "42P01") {
        continue;
      }
      throw error;
    }
  }

  return undefined;
}

/**
 * Whether a task still has work the worker can execute on resume.
 * Completed and cancelled tasks are terminal. A failed task that has used up
 * its retry attempts is also a corpse — resuming it just replays the stored
 * final-attempt error instead of doing new work, so treat it as non-resumable.
 */
export function isResumable(task: ExistingTask): boolean {
  if (task.status === "completed" || task.status === "cancelled") return false;
  if (task.status === "failed" && task.attempt >= task.maxAttempts) return false;
  return true;
}

/** Find an exact topic match among recent tasks. */
export function findExactMatch(
  tasks: ExistingTask[],
  topic: string,
): ExistingTask | undefined {
  const normalized = topic.trim().toLowerCase();
  return tasks.find(
    (t) => t.topic.trim().toLowerCase() === normalized,
  );
}

/** Use LLM to find a semantically similar topic among recent tasks. */
export async function findSimilarTask(
  tasks: ExistingTask[],
  topic: string,
): Promise<ExistingTask | undefined> {
  // Skip LLM if no tasks or only exact matches (already handled)
  const candidates = tasks.filter(
    (t) => t.topic.trim().toLowerCase() !== topic.trim().toLowerCase(),
  );
  if (candidates.length === 0) return undefined;

  const model = getUtilityModel();
  const taskList = candidates
    .map((t, i) => `${i + 1}. "${t.topic}" (${t.status}, ${t.createdAt.toISOString().slice(0, 10)})`)
    .join("\n");

  const message = await completeSimple(model, {
    systemPrompt: [
      `You are a query similarity checker. Given a new research topic and a list of existing topics, determine if any existing topic is semantically similar enough that the user likely wants to continue that research rather than start fresh.`,
      `Respond with ONLY the number of the matching topic (e.g. "3"), or "none" if no good match exists.`,
      `A match means the topics are about essentially the same subject, even if worded differently. Examples:`,
      `- "quantum error correction" ≈ "QEC advances 2024" → match`,
      `- "quantum error correction" ≠ "quantum computing applications" → no match`,
      `Be conservative — only match if the research would clearly overlap.`,
    ].join("\n"),
    messages: [
      {
        role: "user" as const,
        content: `New topic: "${topic}"\n\nExisting topics:\n${taskList}`,
        timestamp: Date.now(),
      },
    ],
  }, {
    maxTokens: 10,
    apiKey: getEnvApiKey(model.provider),
    reasoning: getUtilityReasoning(),
  });

  const text = message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  if (text === "none" || text === "") return undefined;

  const index = parseInt(text, 10) - 1;
  if (isNaN(index) || index < 0 || index >= candidates.length) return undefined;

  return candidates[index];
}
