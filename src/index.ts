// ABOUTME: CLI entry point for the durable research agent.
// ABOUTME: Parses args, finds existing tasks, spawns or resumes, saves reports, and prints usage.

import dotenv from "dotenv";

// Load .env without overriding existing env vars — shell env takes precedence
dotenv.config({ override: false });

import { createResearchApp, type ResearchAppOptions } from "./agent.js";
import type { ResearchParams } from "./types.js";
import { getMaxDurationSeconds } from "./config.js";
import { getModel } from "@mariozechner/pi-ai";
import {
  findRecentTasks,
  findExactMatch,
  findSimilarTask,
  findTaskById,
} from "./task-finder.js";
import { runFollowUp } from "./follow-up.js";
import { runClarification } from "./clarify.js";
import { rebuildStateFromMessages, type UsageStats } from "./durable-turns.js";
import { createResearchEventBus } from "./event-bus.js";
import { createSteeringQueue } from "./steering-queue.js";
import { runTui } from "./tui/run-tui.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResearchNote } from "./types.js";
import {
  printHelp,
  askAction,
  formatTask,
  createIsolatedQueueName,
} from "./cli-help.js";
import { saveReport, printUsage } from "./report-io.js";
import { cleanupTasks } from "./task-cleanup.js";
import { clearStaleLease, defaultWorkerId } from "./lease.js";


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
  let taskQueue = "default";
  let isResume = false;

  // Parse flags with values
  const flagsWithValues = new Set(["--depth", "--max-sources", "--resume", "--model"]);
  const skipNext = new Set<number>();
  args.forEach((a, i) => {
    if (flagsWithValues.has(a)) skipNext.add(i + 1);
  });
  const topic = args.find(
    (a, i) => !a.startsWith("--") && !skipNext.has(i),
  );

  if (resumeIndex < 0 && !topic) {
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

  // TUI is the default for interactive sessions; --no-tui falls back to streamed logs.
  const useTui = !!process.stdin.isTTY && !!process.stdout.isTTY && !args.includes("--no-tui");
  const eventBus = useTui ? createResearchEventBus() : undefined;
  const steeringQueue = useTui ? createSteeringQueue() : undefined;

  // Parse --model (format: provider:modelId, e.g. zai:glm-5.1)
  const modelIndex = args.indexOf("--model");
  let appOptions: ResearchAppOptions = {
    eventBus,
    steeringQueue,
    quiet: useTui,
  };
  let modelLabel = "default";
  if (modelIndex >= 0) {
    const modelStr = args[modelIndex + 1];
    if (!modelStr || !modelStr.includes(":")) {
      console.error('Error: --model format is provider:model (e.g. zai:glm-5.1)');
      process.exit(1);
    }
    const [provider, modelId] = modelStr.split(":");
    try {
      appOptions.model = getModel(provider as any, modelId as any);
      modelLabel = `${provider}:${modelId}`;
      if (!useTui) console.log(`Using model: ${provider}/${modelId}`);
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

  // If no explicit resume, check for existing tasks with same/similar topic
  let existingResult: {
    topic: string;
    report: string;
    notes: ResearchNote[];
    sources: { title: string; url: string }[];
    messages: AgentMessage[];
  } | undefined;
  let liveTopic = topic ?? "resumed research";
  let app = createResearchApp({ ...appOptions, queueName: taskQueue });

  if (resumeIndex >= 0) {
    taskID = args[resumeIndex + 1];
    if (!taskID) {
      console.error("Error: --resume requires a task ID.");
      process.exit(1);
    }

    const existingTask = await findTaskById(taskID);
    if (!existingTask) {
      console.error(`Error: Task "${taskID}" not found.`);
      process.exit(1);
    }

    taskQueue = existingTask.queueName;
    liveTopic = existingTask.topic;
    isResume = true;
    await app.close();
    app = createResearchApp({ ...appOptions, queueName: taskQueue });
    console.log(`\nResuming task: ${taskID}\n`);
  }

  if (!taskID && topic && !forceNew && !forceExtend) {
    const recentTasks = await findRecentTasks();

    // Check for completed tasks first
    const completed = recentTasks.filter((t) => t.status === "completed");
    const completedMatch = findExactMatch(completed, topic);

    if (completedMatch) {
      // Fetch the completed result
      const snapshot = await app.fetchTaskResult(completedMatch.taskId, {
        queue: completedMatch.queueName,
      });
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
          taskQueue = createIsolatedQueueName();
          await app.close();
          app = createResearchApp({ ...appOptions, queueName: taskQueue });
          await app.createQueue();

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
          taskQueue = exact.queueName;
          liveTopic = exact.topic;
          isResume = true;
          await app.close();
          app = createResearchApp({ ...appOptions, queueName: taskQueue });
        } else {
          try {
            const similar = await findSimilarTask(resumable, topic);
            if (similar) {
              console.log(`Found similar in-progress task:`);
              console.log(formatTask(similar));
              console.log(`Resuming (use --new to force a fresh start)...\n`);
              taskID = similar.taskId;
              taskQueue = similar.queueName;
              liveTopic = similar.topic;
              isResume = true;
              await app.close();
              app = createResearchApp({ ...appOptions, queueName: taskQueue });
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
      const snapshot = await app.fetchTaskResult(match.taskId, {
        queue: match.queueName,
      });
      if (snapshot?.state === "completed" && snapshot.result) {
        taskQueue = createIsolatedQueueName();
        await app.close();
        app = createResearchApp({ ...appOptions, queueName: taskQueue });
        await app.createQueue();

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
    taskQueue = createIsolatedQueueName();
    await app.close();
    app = createResearchApp({ ...appOptions, queueName: taskQueue });
    await app.createQueue();

    const params: ResearchParams = { topic, depth, maxSources };

    // Run clarification if requested and interactive
    if (args.includes("--clarify") && process.stdin.isTTY) {
      const clarifications = await runClarification(topic);
      if (clarifications) {
        params.clarifications = clarifications;
      }
    }

    console.log(`\nDurable Researcher`);
    console.log(`Topic: ${topic}`);
    console.log(`Depth: ${depth}`);
    console.log(`Max sources: ${maxSources}`);
    if (params.clarifications) {
      console.log(`Clarifications: ${params.clarifications.split("\n").length / 3} answers captured`);
    }
    console.log(`---\n`);

    const result = await app.spawn("research", params);
    taskID = result.taskID;
    console.log(`Task spawned: ${taskID}`);
  }

  if (!taskID) {
    console.error("Error: No task to run.");
    process.exit(1);
  }

  let tuiHandle: ReturnType<typeof runTui> | undefined;
  if (useTui && eventBus && steeringQueue) {
    tuiHandle = runTui({
      topic: liveTopic,
      maxSources,
      modelLabel,
      bus: eventBus,
      steeringQueue,
    });
    // Surface what the CLI is doing *before* the worker claims — otherwise the
    // TUI sits idle while Absurd polls and waits for any stale lease to expire.
    eventBus.emit({
      type: "agent-status",
      text: isResume ? `Starting worker — claiming task ${taskID?.slice(0, 8)}...` : "Starting worker...",
    });
  } else {
    console.log(`Starting worker...\n`);
  }

  // On resume: if the prior process exited without releasing its lease, the next
  // worker would otherwise block for up to claimTimeout. Detect a lease held by
  // a dead PID on this host and clear it before startWorker polls.
  const workerId = defaultWorkerId();
  if (isResume) {
    try {
      const clear = await clearStaleLease(taskID!, taskQueue);
      if (clear.cleared) {
        const msg = `Cleared stale lease (holder: ${clear.lease?.claimedBy ?? "?"}, reason: ${clear.reason}).`;
        if (eventBus) eventBus.emit({ type: "agent-status", text: msg });
        else console.log(msg);
      } else if (clear.reason === "holder-alive" && clear.lease?.secondsRemaining) {
        const msg = `Another worker still holds the lease (${clear.lease.claimedBy}); waiting up to ${clear.lease.secondsRemaining}s for it to expire.`;
        if (eventBus) eventBus.emit({ type: "agent-status", text: msg });
        else console.log(msg);
      } else if (clear.reason === "different-host" && clear.lease?.secondsRemaining) {
        const msg = `Lease held by another host (${clear.lease.claimedBy}); waiting up to ${clear.lease.secondsRemaining}s for it to expire.`;
        if (eventBus) eventBus.emit({ type: "agent-status", text: msg });
        else console.log(msg);
      }
    } catch (err) {
      // Non-fatal — fall through to normal worker claim polling.
      const msg = `Could not check stale lease: ${(err as Error).message}`;
      if (eventBus) eventBus.emit({ type: "agent-status", text: msg });
      else console.warn(msg);
    }
  }

  // Release our own lease on graceful exit so the next resume is immediate.
  // Idempotent: only fires once even if multiple signals arrive.
  let releasing = false;
  const releaseOwnLease = async (): Promise<void> => {
    if (releasing) return;
    releasing = true;
    try {
      await clearStaleLease(taskID!, taskQueue, {
        force: true,
        currentWorkerId: workerId,
      });
    } catch {
      // Best-effort — if release fails, the lease will expire on its own.
    }
  };

  // SIGINT/SIGTERM: release the lease and exit without waiting on the in-flight
  // task. The task is durable; the next resume rebuilds from checkpoints.
  const onSignal = (signal: NodeJS.Signals) => {
    // Async release, then exit. Don't await worker.close() — it would block on
    // the running task.
    void releaseOwnLease().finally(() => {
      if (!useTui) console.log(`\nReceived ${signal}. Task ${taskID} can be resumed.`);
      process.exit(0);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const worker = await app.startWorker({
    concurrency: 1,
    claimTimeout: 600,
    workerId,
    onError: (err) => {
      eventBus?.emit({ type: "task-error", message: err.message });
      if (!useTui) console.error("Worker error:", err.message);
    },
  });

  // In TUI mode: render the TUI and race the task result against the user quitting.
  let result;
  if (tuiHandle && eventBus) {
    const taskPromise = app.awaitTaskResult(taskID, {
      queue: taskQueue,
      timeout: getMaxDurationSeconds() + 30,
    });

    const winner = await Promise.race([
      taskPromise.then((r) => ({ kind: "task" as const, result: r })),
      tuiHandle.waitForExit.then(() => ({ kind: "tui-exit" as const })),
    ]);

    if (winner.kind === "tui-exit") {
      // Don't kill the task — Absurd checkpoints survive process exit.
      // Release our own lease first so the next resume claims immediately
      // instead of waiting up to claimTimeout for the lease to expire.
      await releaseOwnLease();
      console.log(
        `\nQuit requested. Task ${taskID} can be resumed:\n  bun run src/index.ts --resume ${taskID}`,
      );
      // Don't await worker.close() — it would block on the in-flight task.
      // The lease is already released; let process.exit tear down the worker.
      process.exit(0);
    }

    result = winner.result;
    if (result.state === "completed") {
      eventBus.emit({ type: "task-complete" });
    } else if (result.state === "failed") {
      const failureText =
        typeof result.failure === "string"
          ? result.failure
          : result.failure
          ? JSON.stringify(result.failure)
          : "task failed";
      eventBus.emit({ type: "task-error", message: failureText });
    }
    await tuiHandle.waitForExit;
  } else {
    result = await app.awaitTaskResult(taskID, {
      queue: taskQueue,
      timeout: getMaxDurationSeconds() + 30, // extra buffer beyond task max duration
    });
  }

  if (result.state === "completed" && result.result) {
    const research = result.result as unknown as {
      topic: string;
      report: string;
      sources: { title: string; url: string }[];
      notes: ResearchNote[];
      messages: AgentMessage[];
    };

    // Print report if it wasn't already streamed by the logging persister.
    // On timeout, the report is built from notes and was never streamed.
    // On resume, the agent produced the report in a previous run.
    // In TUI mode, the persister is quiet so the report needs to be printed here.
    // On a normal fresh run with logs, the persister already printed it.
    if (research.report) {
      const isPartialReport = research.report.startsWith("[Partial results");
      if (useTui || isResume || isPartialReport) {
        console.log("\n" + "=".repeat(80));
        console.log("RESEARCH REPORT");
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
