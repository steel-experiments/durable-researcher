// ABOUTME: CLI entry point for the durable research agent.
// ABOUTME: Parses args, finds existing tasks, spawns or resumes, saves reports, and prints usage.

import dotenv from "dotenv";

// Load .env without overriding existing env vars — shell env takes precedence
dotenv.config({ override: false });

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createResearchApp, type ResearchAppOptions } from "./agent.js";
import type { ResearchParams } from "./types.js";
import type { UsageStats } from "./durable-turns.js";
import { getModel } from "@mariozechner/pi-ai";
import {
  findRecentTasks,
  findExactMatch,
  findSimilarTask,
  type ExistingTask,
} from "./task-finder.js";
import { runFollowUp } from "./follow-up.js";
import { rebuildStateFromMessages } from "./durable-turns.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResearchNote } from "./types.js";
import pg from "pg";

function printHelp() {
  console.log(`
Usage: bun run src/index.ts <topic> [options]

Options:
  --depth <quick|standard|deep>   Research depth (default: standard)
  --max-sources <number>          Maximum sources to consult (default: 20)
  --model <provider:model>        LLM model (default: zai:glm-5.1)
  --resume <task-id>              Resume a specific task by ID
  --new                           Start fresh, ignore existing research
  --extend                        Extend prior research with more sources
  --view                          View existing report without re-running
  --list                          List recent research tasks
  --cleanup                       Remove completed/failed/cancelled tasks

Examples:
  bun run src/index.ts "quantum error correction advances"
  bun run src/index.ts "impact of AI on journalism" --depth deep
  bun run src/index.ts "quantum error correction" --extend
  bun run src/index.ts "quantum error correction" --view
  bun run src/index.ts --resume 019d6485-29ae-7484-a08e-659bb5a82b8c
  bun run src/index.ts --list
  bun run src/index.ts --cleanup
`);
}

/** Prompt the user to choose an action for an existing completed task. */
async function askAction(): Promise<"view" | "extend" | "new"> {
  const rl = (await import("node:readline")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\nWhat would you like to do?");
    console.log("  [v] View existing report");
    console.log("  [e] Extend research with more sources");
    console.log("  [n] Start fresh research\n");
    rl.question("Choice (v/e/n): ", (answer) => {
      rl.close();
      const choice = answer.trim().toLowerCase();
      if (choice === "e" || choice === "extend") resolve("extend");
      else if (choice === "n" || choice === "new") resolve("new");
      else resolve("view");
    });
  });
}

function formatTask(task: ExistingTask): string {
  const age = Math.round((Date.now() - task.createdAt.getTime()) / 60000);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
  return `  ${task.taskId}  "${task.topic}" [${task.status}] (${ageStr}, attempt ${task.attempt}/${task.maxAttempts})`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function saveReport(topic: string, report: string): string {
  const outputDir = resolve(process.cwd(), "output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${slugify(topic)}-${date}.md`;
  const filepath = resolve(outputDir, filename);
  writeFileSync(filepath, `# ${topic}\n\n${report}\n`);
  return filepath;
}

function printUsage(usage: UsageStats) {
  console.log("\n--- Token Usage ---");
  console.log(
    `Total: ${usage.inputTokens.toLocaleString()} input, ${usage.outputTokens.toLocaleString()} output`,
  );
  if (usage.cacheReadTokens > 0) {
    console.log(`Cache reads: ${usage.cacheReadTokens.toLocaleString()}`);
  }
  for (const [model, counts] of Object.entries(usage.models)) {
    console.log(
      `  ${model}: ${counts.input.toLocaleString()} in / ${counts.output.toLocaleString()} out`,
    );
  }
}

const DEFAULT_DB_URL = "postgresql://postgres:postgres@localhost:5432/absurd";

async function cleanupTasks() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DB_URL,
  });
  try {
    // Delete checkpoints and runs for terminal tasks, then the tasks themselves
    const result = await pool.query(`
      WITH terminal AS (
        SELECT task_id FROM absurd.t_default
        WHERE state IN ('completed', 'failed', 'cancelled')
      )
      DELETE FROM absurd.c_default
      WHERE run_id IN (
        SELECT r.run_id FROM absurd.r_default r
        JOIN terminal t ON r.task_id = t.task_id
      )
    `);
    await pool.query(`
      DELETE FROM absurd.r_default
      WHERE task_id IN (
        SELECT task_id FROM absurd.t_default
        WHERE state IN ('completed', 'failed', 'cancelled')
      )
    `);
    const deleted = await pool.query(`
      DELETE FROM absurd.t_default
      WHERE state IN ('completed', 'failed', 'cancelled')
      RETURNING task_id
    `);
    console.log(`Cleaned up ${deleted.rowCount} tasks.`);
  } finally {
    await pool.end();
  }
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

  // --cleanup: remove terminal tasks and exit
  if (args.includes("--cleanup")) {
    await cleanupTasks();
    process.exit(0);
  }

  const forceNew = args.includes("--new");
  const forceExtend = args.includes("--extend");
  const forceView = args.includes("--view");

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

  // Parse flags with values
  const flagsWithValues = new Set(["--depth", "--max-sources", "--resume", "--model"]);
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

  // Parse --depth
  const depthIndex = args.indexOf("--depth");
  const depth = depthIndex >= 0
    ? (args[depthIndex + 1] as "quick" | "standard" | "deep")
    : "standard";

  // Parse --max-sources
  const maxSourcesIndex = args.indexOf("--max-sources");
  const maxSources = maxSourcesIndex >= 0
    ? parseInt(args[maxSourcesIndex + 1], 10)
    : 20;

  // Parse --model (format: provider:modelId, e.g. zai:glm-5.1)
  const modelIndex = args.indexOf("--model");
  let appOptions: ResearchAppOptions = {};
  if (modelIndex >= 0) {
    const modelStr = args[modelIndex + 1];
    if (!modelStr || !modelStr.includes(":")) {
      console.error('Error: --model format is provider:model (e.g. zai:glm-5.1)');
      process.exit(1);
    }
    const [provider, modelId] = modelStr.split(":");
    try {
      appOptions.model = getModel(provider as any, modelId as any);
      console.log(`Using model: ${provider}/${modelId}`);
    } catch {
      console.error(`Error: Unknown model "${modelStr}".`);
      process.exit(1);
    }
  }

  if (!["quick", "standard", "deep"].includes(depth)) {
    console.error(
      `Error: Invalid depth "${depth}". Use quick, standard, or deep.`,
    );
    process.exit(1);
  }

  const app = createResearchApp(appOptions);

  // If no explicit resume, check for existing tasks with same/similar topic
  let existingResult: {
    topic: string;
    report: string;
    notes: ResearchNote[];
    sources: { title: string; url: string }[];
    messages: AgentMessage[];
  } | undefined;

  if (!taskID && topic && !forceNew && !forceExtend) {
    const recentTasks = await findRecentTasks();

    // Check for completed tasks first
    const completed = recentTasks.filter((t) => t.status === "completed");
    const completedMatch = findExactMatch(completed, topic);

    if (completedMatch) {
      // Fetch the completed result
      const snapshot = await app.fetchTaskResult(completedMatch.taskId);
      if (snapshot?.state === "completed" && snapshot.result) {
        existingResult = snapshot.result as unknown as typeof existingResult;

        console.log(`Found completed research on this topic:`);
        console.log(formatTask(completedMatch));

        // Determine action: flag, interactive, or default
        let action: "view" | "extend" | "new";
        if (forceView) {
          action = "view";
        } else if (process.stdin.isTTY) {
          action = await askAction();
        } else {
          action = "view";
        }

        if (action === "view") {
          // Print report and offer follow-up
          console.log("\n" + "=".repeat(80));
          console.log(`RESEARCH REPORT: ${existingResult!.topic}`);
          console.log("=".repeat(80) + "\n");
          console.log(existingResult!.report);
          console.log("\n" + "-".repeat(80));
          console.log(`Sources consulted: ${existingResult!.sources?.length ?? 0}`);

          if (existingResult!.messages?.length && process.stdin.isTTY) {
            const { scrapedUrls } = rebuildStateFromMessages(existingResult!.messages);
            await runFollowUp(
              existingResult!.messages,
              existingResult!.topic,
              existingResult!.notes ?? [],
              scrapedUrls,
              appOptions.model,
            );
          }
          await app.close();
          process.exit(0);
        } else if (action === "extend") {
          // Spawn new task seeded with prior findings
          const params: ResearchParams = {
            topic,
            depth,
            maxSources,
            priorNotes: existingResult!.notes,
            priorUrls: existingResult!.sources?.map((s) => s.url),
          };
          console.log(
            `\nExtending research with ${existingResult!.notes?.length ?? 0} prior notes, ${existingResult!.sources?.length ?? 0} prior sources...\n`,
          );
          const result = await app.spawn("research", params);
          taskID = result.taskID;
          console.log(`Task spawned: ${taskID}`);
        } else {
          // action === "new" — fall through to spawn new
        }
      }
    }

    // Check for in-progress tasks
    if (!taskID && !existingResult) {
      const resumable = recentTasks.filter(
        (t) => t.status !== "completed" && t.status !== "cancelled",
      );
      if (resumable.length > 0) {
        const exact = findExactMatch(resumable, topic);
        if (exact) {
          console.log(`Found in-progress task with same topic:`);
          console.log(formatTask(exact));
          console.log(`Resuming...\n`);
          taskID = exact.taskId;
          isResume = true;
        } else {
          try {
            const similar = await findSimilarTask(resumable, topic);
            if (similar) {
              console.log(`Found similar in-progress task:`);
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
  }

  // Handle --extend flag directly (without interactive prompt)
  if (!taskID && topic && forceExtend && !existingResult) {
    const recentTasks = await findRecentTasks();
    const completed = recentTasks.filter((t) => t.status === "completed");
    const match = findExactMatch(completed, topic);
    if (match) {
      const snapshot = await app.fetchTaskResult(match.taskId);
      if (snapshot?.state === "completed" && snapshot.result) {
        const prior = snapshot.result as unknown as {
          notes: ResearchNote[];
          sources: { title: string; url: string }[];
        };
        const params: ResearchParams = {
          topic,
          depth,
          maxSources,
          priorNotes: prior.notes,
          priorUrls: prior.sources?.map((s: { url: string }) => s.url),
        };
        console.log(
          `\nExtending research with ${prior.notes?.length ?? 0} prior notes, ${prior.sources?.length ?? 0} prior sources...\n`,
        );
        const result = await app.spawn("research", params);
        taskID = result.taskID;
        console.log(`Task spawned: ${taskID}`);
      }
    }
    if (!taskID) {
      console.log("No completed research found to extend. Starting fresh.\n");
    }
  }

  // Spawn new task if we still don't have one
  if (!taskID && topic) {
    const params: ResearchParams = { topic, depth, maxSources };

    console.log(`\nDurable Researcher`);
    console.log(`Topic: ${topic}`);
    console.log(`Depth: ${depth}`);
    console.log(`Max sources: ${maxSources}`);
    console.log(`---\n`);

    const result = await app.spawn("research", params);
    taskID = result.taskID;
    console.log(`Task spawned: ${taskID}`);
  }

  if (!taskID) {
    console.error("Error: No task to run.");
    process.exit(1);
  }

  console.log(`Starting worker...\n`);

  const worker = await app.startWorker({
    concurrency: 1,
    claimTimeout: 300,
    onError: (err) => console.error("Worker error:", err.message),
  });

  const result = await app.awaitTaskResult(taskID, {
    timeout: 600_000,
  });

  if (result.state === "completed" && result.result) {
    const research = result.result as unknown as {
      topic: string;
      report: string;
      sources: { title: string; url: string }[];
      notes: ResearchNote[];
      messages: AgentMessage[];
    };

    // Print report if it wasn't streamed (e.g. resumed completed task)
    if (research.report) {
      if (isResume) {
        console.log("\n" + "=".repeat(80));
        console.log(`RESEARCH REPORT: ${research.topic}`);
        console.log("=".repeat(80) + "\n");
        console.log(research.report);
      }
      const filepath = saveReport(research.topic, research.report);
      console.log(`\nReport saved to: ${filepath}`);
    }

    console.log("-".repeat(80));
    console.log(`Sources consulted: ${research.sources.length}`);

    // Print usage stats
    const usage = (app as any).getLastUsage?.() as UsageStats | undefined;
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      printUsage(usage);
    }

    await worker.close();

    // Offer follow-up questions if we have messages
    if (research.messages?.length > 0 && process.stdin.isTTY) {
      const { scrapedUrls } = rebuildStateFromMessages(research.messages);
      await runFollowUp(
        research.messages,
        research.topic,
        research.notes ?? [],
        scrapedUrls,
        appOptions.model,
      );
    }

    await app.close();
  } else {
    if (result.state === "failed") {
      console.error("\nResearch task failed:", result.failure);
    } else {
      console.error("\nUnexpected task state:", result.state);
    }

    const usage = (app as any).getLastUsage?.() as UsageStats | undefined;
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      printUsage(usage);
    }

    await worker.close();
    await app.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
