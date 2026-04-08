// ABOUTME: Finds existing research tasks for resume or deduplication.
// ABOUTME: Queries Postgres for recent tasks and uses LLM for fuzzy topic matching.

import pg from "pg";
import { completeSimple, getModel, getEnvApiKey } from "@mariozechner/pi-ai";

export type ExistingTask = {
  taskId: string;
  topic: string;
  status: string;
  createdAt: Date;
  attempt: number;
  maxAttempts: number;
};

const DEFAULT_DB_URL = "postgresql://postgres:postgres@localhost:5432/absurd";

/** Query Postgres for recent research tasks with their params. */
export async function findRecentTasks(
  databaseUrl?: string,
  limit = 20,
): Promise<ExistingTask[]> {
  const pool = new pg.Pool({
    connectionString: databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DB_URL,
  });

  try {
    const result = await pool.query(
      `SELECT t.task_id, t.params, t.state, t.enqueue_at, t.attempts, t.max_attempts
       FROM absurd.t_default t
       WHERE t.task_name = 'research'
       ORDER BY t.enqueue_at DESC
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
      topic: row.params?.topic ?? "unknown",
      status: row.state,
      createdAt: row.enqueue_at,
      attempt: row.attempts,
      maxAttempts: row.max_attempts ?? 3,
    }));
  } finally {
    await pool.end();
  }
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

  const model = getModel("zai", "glm-5.1");
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
    apiKey: getEnvApiKey("zai"),
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
