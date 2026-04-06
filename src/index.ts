// ABOUTME: CLI entry point for the durable research agent.
// ABOUTME: Parses args, finds existing tasks, spawns or resumes, and prints the result.

import dotenv from "dotenv";

// Load .env without overriding existing env vars — shell env takes precedence
dotenv.config({ override: false });

import { createResearchApp } from "./agent.js";
import type { ResearchParams } from "./types.js";
import {
  findRecentTasks,
  findExactMatch,
  findSimilarTask,
  type ExistingTask,
} from "./task-finder.js";

function printHelp() {
  console.log(`
Usage: bun run src/index.ts <topic> [options]

Options:
  --depth <quick|standard|deep>   Research depth (default: standard)
  --max-sources <number>          Maximum sources to consult (default: 20)
  --resume <task-id>              Resume a specific task by ID
  --new                           Force a new task even if a similar one exists
  --list                          List recent research tasks

Examples:
  bun run src/index.ts "quantum error correction advances"
  bun run src/index.ts "impact of AI on journalism" --depth deep
  bun run src/index.ts --resume 019d6485-29ae-7484-a08e-659bb5a82b8c
  bun run src/index.ts --list
`);
}

function formatTask(task: ExistingTask): string {
  const age = Math.round((Date.now() - task.createdAt.getTime()) / 60000);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
  return `  ${task.taskId}  "${task.topic}" [${task.status}] (${ageStr}, attempt ${task.attempt}/${task.maxAttempts})`;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // --list: show recent tasks and exit
  if (args.includes("--list")) {
    const tasks = await findRecentTasks();
    if (tasks.length === 0) {
      console.log("No recent research tasks found.");
    } else {
      console.log("Recent research tasks:\n");
      for (const task of tasks) {
        console.log(formatTask(task));
      }
    }
    process.exit(0);
  }

  const forceNew = args.includes("--new");

  // --resume <task-id>: explicit resume
  const resumeIndex = args.indexOf("--resume");
  let taskID: string | undefined;
  let isResume = false;

  if (resumeIndex >= 0) {
    taskID = args[resumeIndex + 1];
    if (!taskID) {
      console.error("Error: --resume requires a task ID.");
      process.exit(1);
    }
    isResume = true;
    console.log(`\nResuming task: ${taskID}\n`);
  }

  // Parse topic (first non-flag argument, skip flag values)
  const flagsWithValues = new Set(["--depth", "--max-sources", "--resume"]);
  const skipNext = new Set<number>();
  args.forEach((a, i) => {
    if (flagsWithValues.has(a)) skipNext.add(i + 1);
  });
  const topic = args.find(
    (a, i) => !a.startsWith("--") && !skipNext.has(i),
  );

  if (!taskID && !topic) {
    console.error("Error: No research topic provided.");
    process.exit(1);
  }

  // Parse flags
  const depthIndex = args.indexOf("--depth");
  const depth = depthIndex >= 0
    ? (args[depthIndex + 1] as "quick" | "standard" | "deep")
    : "standard";

  const maxSourcesIndex = args.indexOf("--max-sources");
  const maxSources = maxSourcesIndex >= 0
    ? parseInt(args[maxSourcesIndex + 1], 10)
    : 20;

  if (!["quick", "standard", "deep"].includes(depth)) {
    console.error(
      `Error: Invalid depth "${depth}". Use quick, standard, or deep.`,
    );
    process.exit(1);
  }

  const app = createResearchApp();

  // If no explicit resume, check for existing tasks with same/similar topic
  if (!taskID && topic && !forceNew) {
    const recentTasks = await findRecentTasks();
    const resumable = recentTasks.filter(
      (t) => t.status !== "completed" && t.status !== "cancelled",
    );

    if (resumable.length > 0) {
      // Check exact match first
      const exact = findExactMatch(resumable, topic);
      if (exact) {
        console.log(`Found existing task with same topic:`);
        console.log(formatTask(exact));
        console.log(`Resuming...\n`);
        taskID = exact.taskId;
        isResume = true;
      } else {
        // Check fuzzy match via LLM
        try {
          const similar = await findSimilarTask(resumable, topic);
          if (similar) {
            console.log(`Found similar existing task:`);
            console.log(formatTask(similar));
            console.log(`Resuming (use --new to force a fresh start)...\n`);
            taskID = similar.taskId;
            isResume = true;
          }
        } catch {
          // LLM similarity check failed — proceed with new task
        }
      }
    }
  }

  // Spawn new task if we don't have one to resume
  if (!taskID && topic) {
    const params: ResearchParams = { topic, depth, maxSources };

    console.log(`\nDurable Researcher`);
    console.log(`Topic: ${topic}`);
    console.log(`Depth: ${depth}`);
    console.log(`Max sources: ${maxSources}`);
    console.log(`---\n`);

    // Use normalized topic as idempotency key — Absurd returns
    // the existing task if the key matches instead of creating a new one
    const idempotencyKey = `research:${topic.trim().toLowerCase()}`;
    const result = await app.spawn("research", params, { idempotencyKey });
    taskID = result.taskID;

    if (result.created) {
      console.log(`Task spawned: ${taskID}`);
    } else {
      console.log(`Resuming existing task: ${taskID} (exact topic match)`);
      isResume = true;
    }
  }

  if (!taskID) {
    console.error("Error: No task to run.");
    process.exit(1);
  }

  console.log(`Starting worker...\n`);

  // Start worker to process the task
  const worker = await app.startWorker({
    concurrency: 1,
    claimTimeout: 300,
    onError: (err) => console.error("Worker error:", err.message),
  });

  // Poll for completion
  const result = await app.awaitTaskResult(taskID, {
    timeout: 600_000,
  });

  if (result.state === "completed" && result.result) {
    const research = result.result as unknown as {
      topic: string;
      report: string;
      sources: { title: string; url: string }[];
    };
    console.log("\n" + "=".repeat(80));
    console.log(`RESEARCH REPORT: ${research.topic}`);
    console.log("=".repeat(80) + "\n");
    console.log(research.report);
    console.log("\n" + "-".repeat(80));
    console.log(`Sources consulted: ${research.sources.length}`);
  } else if (result.state === "failed") {
    console.error("\nResearch task failed:", result.failure);
  } else {
    console.error("\nUnexpected task state:", result.state);
  }

  await worker.close();
  await app.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
