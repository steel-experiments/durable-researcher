// ABOUTME: CLI entry point for the durable research agent.
// ABOUTME: Parses args, finds existing tasks, spawns or resumes, saves reports, and prints usage.

import dotenv from "dotenv";
import { randomUUID } from "node:crypto";

// Load .env without overriding existing env vars — shell env takes precedence
dotenv.config({ override: false });

import { createResearchApp, type ResearchAppOptions } from "./agent.js";
import type { ResearchParams } from "./types.js";
import { DEPTH_CONFIG } from "./types.js";
import { getModel } from "@mariozechner/pi-ai";
import { setUtilityModelOverride } from "./config.js";
import {
  findRecentTasks,
  findExactMatch,
  findSimilarTask,
  isResumable,
  findTaskById,
} from "./task-finder.js";
import { runFollowUp } from "./follow-up.js";
import { runClarification } from "./clarify.js";
import { rebuildStateFromMessages } from "./durable-turns.js";
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
import { cleanupTasks } from "./task-cleanup.js";
import { reapOrphanedTasksAllQueues } from "./lease.js";
import { showVerification } from "./verification-inspector.js";
import { runCampaignCli } from "./campaign-cli.js";
import { parseResearchCliArgs, validateResearchCliArgs } from "./cli-args.js";
import { runResearchWorkerUntilResult } from "./cli-runner.js";
import {
  printCompletedResearchResult,
  printTaskFailure,
  printUsageIfPresent,
  type CompletedResearchForCli,
} from "./cli-output.js";
import { createResearchService } from "./service/research-service.js";
import type { ResearchRunParams } from "./service/research-runs.js";
import type { ResearchRunTask } from "./service/research-tasks.js";

function researchFromServiceRun(
  topic: string,
  report: string,
  tasks: ResearchRunTask[],
): CompletedResearchForCli {
  const notes = tasks.flatMap((task) => task.result?.notes ?? []);
  const sourcesByUrl = new Map<string, { title: string; url: string }>();
  for (const task of tasks) {
    for (const source of task.result?.sources ?? []) {
      if (!sourcesByUrl.has(source.url)) sourcesByUrl.set(source.url, source);
    }
  }
  return {
    topic,
    report,
    notes,
    sources: [...sourcesByUrl.values()],
    messages: [],
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "campaign") {
    try {
      await runCampaignCli(args);
    } catch (err) {
      console.error(`Campaign error: ${(err as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

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

  // --show-verification <task-id>: dump per-claim verdicts for the task's
  // verify-claims-attempt-N checkpoints and exit.
  const showVerifyIdx = args.indexOf("--show-verification");
  if (showVerifyIdx >= 0) {
    const targetId = args[showVerifyIdx + 1];
    if (!targetId) {
      console.error("Error: --show-verification requires a task ID.");
      process.exit(1);
    }
    await showVerification(targetId);
    process.exit(0);
  }

  // Sweep orphaned running tasks (workers that died without releasing their lease)
  // before doing anything else. Without this, dead-worker tasks stay state='running'
  // forever and pollute `--list` output. Best-effort: per-queue failures are swallowed.
  try {
    const reaped = await reapOrphanedTasksAllQueues();
    const actuallyReaped = reaped.filter((r) => r.reaped);
    if (actuallyReaped.length > 0) {
      console.log(`Reaped ${actuallyReaped.length} orphaned task(s) from prior runs.`);
    }
  } catch {
    // Schema missing or DB unreachable — proceed; the rest of the CLI will surface
    // a clearer error if the DB is genuinely down.
  }

  const cli = parseResearchCliArgs(args);
  let taskID: string | undefined;
  let taskQueue = "default";
  let isResume = false;

  const validationError = validateResearchCliArgs(cli);
  if (validationError) {
    console.error(`Error: ${validationError}`);
    process.exit(1);
  }

  const { topic, depth, maxSources } = cli;

  // TUI is the default for interactive sessions; --no-tui falls back to streamed logs.
  const useTui = !!process.stdin.isTTY && !!process.stdout.isTTY && !cli.noTui;
  const eventBus = useTui ? createResearchEventBus() : undefined;
  const steeringQueue = useTui ? createSteeringQueue() : undefined;

  // Parse --model (format: provider:modelId, e.g. zai:glm-5.1)
  let appOptions: ResearchAppOptions = {
    eventBus,
    steeringQueue,
    quiet: useTui,
  };
  let modelLabel = "default";
  if (cli.modelSpec) {
    const [provider, modelId] = cli.modelSpec.split(":");
    try {
      appOptions.model = getModel(provider as any, modelId as any);
      setUtilityModelOverride(appOptions.model);
      modelLabel = `${provider}:${modelId}`;
      if (!useTui) console.log(`Using model: ${provider}/${modelId}`);
    } catch {
      console.error(`Error: Unknown model "${cli.modelSpec}".`);
      process.exit(1);
    }
  }

  async function runServiceDeepResearch(runTopic: string, clarifications?: string): Promise<void> {
    const service = createResearchService({ appOptions });
    const params: ResearchRunParams = {
      topic: runTopic,
      depth,
      mode: undefined,
      clarify: clarifications,
      budgets: {
        maxSources: maxSources ?? DEPTH_CONFIG[depth].maxSources,
      },
    };
    const { run } = await service.createRun({
      params,
      idempotencyKey: `cli:${Date.now()}:${randomUUID()}`,
    });

    let tuiHandle: ReturnType<typeof runTui> | undefined;
    let quitPromise: Promise<void> | undefined;
    const requestQuit = (): Promise<void> => {
      if (!quitPromise) {
        if (eventBus) eventBus.emit({ type: "agent-status", text: "Cancelling run..." });
        quitPromise = service.cancelRun(run.id)
          .catch((err) => {
            if (eventBus) eventBus.emit({ type: "task-error", message: (err as Error).message });
            else console.error(`Cancel failed: ${(err as Error).message}`);
          })
          .then(() => undefined);
      }
      return quitPromise;
    };
    if (useTui && eventBus && steeringQueue) {
      tuiHandle = runTui({
        topic: runTopic,
        maxSources: params.budgets.maxSources ?? DEPTH_CONFIG[depth].maxSources,
        modelLabel,
        bus: eventBus,
        steeringQueue,
        onQuit: () => {
          void requestQuit();
        },
        onExtend: () => undefined,
      });
      eventBus.emit({
        type: "agent-status",
        text: `Starting ${run.kind} run ${run.id.slice(0, 8)}...`,
      });
    } else {
      console.log(`\nDurable Researcher`);
      console.log(`Topic: ${runTopic}`);
      console.log(`Depth: ${depth}`);
      console.log(`Harness: ${run.kind}`);
      console.log(`Max sources: ${params.budgets.maxSources ?? `${DEPTH_CONFIG[depth].maxSources} (depth default)`}`);
      if (clarifications) {
        console.log(`Clarifications: ${clarifications.split("\n").length / 3} answers captured`);
      }
      console.log(`---\n`);
      console.log(`Research run created: ${run.id}`);
    }
    await service.startRun(run.id);

    let lastStatus = run.status;
    const tuiExit = tuiHandle?.waitForExit.then(() => "tui-exit" as const);
    try {
      while (true) {
        const tick = new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 2000));
        const next = tuiExit ? await Promise.race([tick, tuiExit]) : await tick;
        if (next === "tui-exit") {
          await requestQuit();
          tuiHandle?.unmount();
          console.log(`\nQuit requested. Research run cancelled: ${run.id}`);
          return;
        }
        const current = await service.getRun(run.id);
        if (current.status !== lastStatus) {
          if (useTui && eventBus) {
            eventBus.emit({ type: "agent-status", text: `Run status: ${current.status}` });
          } else {
            console.log(`Run status: ${current.status}`);
          }
          lastStatus = current.status;
        }
        if (current.status === "completed") {
          const [{ report }, tasks] = await Promise.all([
            service.getReport(run.id),
            service.listTasks(run.id),
          ]);
          const research = researchFromServiceRun(runTopic, report ?? "", tasks);
          if (useTui && eventBus) eventBus.emit({ type: "phase", phase: "complete" });
          tuiHandle?.unmount();
          printCompletedResearchResult(research, { useTui, isResume: false });
          return;
        }
        if (current.status === "failed" || current.status === "cancelled") {
          if (current.status === "cancelled" && quitPromise) {
            tuiHandle?.unmount();
            console.log(`\nQuit requested. Research run cancelled: ${run.id}`);
            return;
          }
          throw new Error(`Research run ${current.status}: ${run.id}`);
        }
      }
    } catch (err) {
      tuiHandle?.unmount();
      throw err;
    }
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

  if (cli.resumeTaskId) {
    taskID = cli.resumeTaskId;
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

  if (!taskID && topic && !cli.forceNew && !cli.forceExtend) {
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
        if (cli.forceView) {
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
      const resumable = recentTasks.filter(isResumable);
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
  if (!taskID && topic && cli.forceExtend && !existingResult) {
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
    let clarifications: string | undefined;
    if (cli.clarify && process.stdin.isTTY) {
      clarifications = await runClarification(topic);
    }

    if (depth === "deep" && !cli.resumeTaskId) {
      await app.close();
      await runServiceDeepResearch(topic, clarifications);
      process.exit(0);
    }

    taskQueue = createIsolatedQueueName();
    await app.close();
    app = createResearchApp({ ...appOptions, queueName: taskQueue });
    await app.createQueue();

    const params: ResearchParams = { topic, depth, maxSources };

    // Run clarification if requested and interactive
    if (clarifications) {
      params.clarifications = clarifications;
    }

    console.log(`\nDurable Researcher`);
    console.log(`Topic: ${topic}`);
    console.log(`Depth: ${depth}`);
    console.log(`Max sources: ${maxSources ?? `${DEPTH_CONFIG[depth].maxSources} (depth default)`}`);
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

  while (taskID) {
    let extensionInstruction: string | undefined;
    let tuiHandle: ReturnType<typeof runTui> | undefined;
    if (useTui && eventBus && steeringQueue) {
      tuiHandle = runTui({
        topic: liveTopic,
        maxSources: maxSources ?? DEPTH_CONFIG[depth].maxSources,
        modelLabel,
        bus: eventBus,
        steeringQueue,
        onExtend: (instruction) => {
          extensionInstruction = instruction;
        },
      });
      // Surface what the CLI is doing *before* the worker claims — otherwise the
      // TUI sits idle while Absurd polls and waits for any stale lease to expire.
      eventBus.emit({
        type: "agent-status",
        text: isResume ? `Starting worker — claiming task ${taskID.slice(0, 8)}...` : "Starting worker...",
      });
    } else {
      console.log(`Starting worker...\n`);
    }

    const result = await runResearchWorkerUntilResult({
      app,
      taskID,
      taskQueue,
      isResume,
      useTui,
      eventBus,
      tuiHandle,
    }) as Awaited<ReturnType<typeof app.awaitTaskResult>>;

    if (result.state === "completed" && result.result) {
      const research = result.result as unknown as CompletedResearchForCli;
      printCompletedResearchResult(research, { useTui, isResume });
      printUsageIfPresent((app as any).getLastUsage?.());

      if (extensionInstruction && useTui) {
        const priorUrls = research.sources?.map((s) => s.url) ?? [];
        const params: ResearchParams = {
          topic: research.topic,
          depth,
          maxSources,
          priorNotes: research.notes ?? [],
          priorUrls,
          extensionInstruction,
        };

        taskQueue = createIsolatedQueueName();
        await app.close();
        app = createResearchApp({ ...appOptions, queueName: taskQueue });
        await app.createQueue();

        console.log(
          `\nExtending research with ${params.priorNotes?.length ?? 0} prior notes, ${priorUrls.length} prior sources...`,
        );
        console.log(`Instruction: ${extensionInstruction}\n`);
        const spawned = await app.spawn("research", params);
        taskID = spawned.taskID;
        liveTopic = research.topic;
        isResume = false;
        console.log(`Task spawned: ${taskID}`);
        continue;
      }

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
      break;
    } else {
      printTaskFailure(result);
      printUsageIfPresent((app as any).getLastUsage?.());

      await app.close();
      break;
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
