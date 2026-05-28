// ABOUTME: Worker lifecycle helper for the research CLI.
// ABOUTME: Encapsulates lease cleanup, signal handling, TUI exit racing, and task-result waiting.

import type { Absurd } from "absurd-sdk";
import type { ResearchEventBus } from "./event-bus.js";
import { clearStaleLease, defaultWorkerId } from "./lease.js";
import { getMaxDurationSeconds } from "./config.js";
import type { runTui } from "./tui/run-tui.js";

type TuiHandle = ReturnType<typeof runTui>;

export type RunResearchWorkerOptions = {
  app: Absurd;
  taskID: string;
  taskQueue: string;
  isResume: boolean;
  useTui: boolean;
  eventBus?: ResearchEventBus;
  tuiHandle?: TuiHandle;
};

export async function runResearchWorkerUntilResult(opts: RunResearchWorkerOptions): Promise<unknown> {
  const { app, taskID, taskQueue, isResume, useTui, eventBus, tuiHandle } = opts;

  const workerId = defaultWorkerId();
  if (isResume) {
    await reportStaleLeaseStatus(taskID, taskQueue, eventBus);
  }
  eventBus?.emit({ type: "agent-status", text: "Starting worker claim..." });

  let releasing = false;
  const releaseOwnLease = async (): Promise<void> => {
    if (releasing) return;
    releasing = true;
    try {
      await clearStaleLease(taskID, taskQueue, {
        force: true,
        currentWorkerId: workerId,
      });
    } catch {
      // Best-effort — if release fails, the lease will expire on its own.
    }
  };

  const onSignal = (signal: NodeJS.Signals) => {
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

  try {
    if (tuiHandle && eventBus) {
      const taskPromise = app.awaitTaskResult(taskID, {
        queue: taskQueue,
        timeout: getMaxDurationSeconds() + 30,
      });

      const winner = await Promise.race([
        taskPromise.then((result) => ({ kind: "task" as const, result })),
        tuiHandle.waitForExit.then(() => ({ kind: "tui-exit" as const })),
      ]);

      if (winner.kind === "tui-exit") {
        await releaseOwnLease();
        console.log(
          `\nQuit requested. Task ${taskID} can be resumed:\n  bun run src/index.ts --resume ${taskID}`,
        );
        process.exit(0);
      }

      if (winner.result.state === "completed") {
        eventBus.emit({ type: "task-complete" });
      } else if (winner.result.state === "failed") {
        const failureText =
          typeof winner.result.failure === "string"
            ? winner.result.failure
            : winner.result.failure
            ? JSON.stringify(winner.result.failure)
            : "task failed";
        eventBus.emit({ type: "task-error", message: failureText });
      } else {
        eventBus.emit({ type: "task-error", message: `Task ${winner.result.state}.` });
      }
      await tuiHandle.waitForExit;
      return winner.result;
    }

    return await app.awaitTaskResult(taskID, {
      queue: taskQueue,
      timeout: getMaxDurationSeconds() + 30,
    });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await worker.close();
  }
}

async function reportStaleLeaseStatus(
  taskID: string,
  taskQueue: string,
  eventBus?: ResearchEventBus,
): Promise<void> {
  try {
    const clear = await clearStaleLease(taskID, taskQueue);
    if (clear.cleared) {
      emitStatus(
        eventBus,
        `Cleared stale lease (holder: ${clear.lease?.claimedBy ?? "?"}, reason: ${clear.reason}).`,
      );
    } else if (clear.reason === "holder-alive" && clear.lease?.secondsRemaining) {
      emitStatus(
        eventBus,
        `Another worker still holds the lease (${clear.lease.claimedBy}); waiting up to ${clear.lease.secondsRemaining}s for it to expire.`,
      );
    } else if (clear.reason === "different-host" && clear.lease?.secondsRemaining) {
      emitStatus(
        eventBus,
        `Lease held by another host (${clear.lease.claimedBy}); waiting up to ${clear.lease.secondsRemaining}s for it to expire.`,
      );
    }
  } catch (err) {
    emitStatus(eventBus, `Could not check stale lease: ${(err as Error).message}`, true);
  }
}

function emitStatus(eventBus: ResearchEventBus | undefined, text: string, warn = false): void {
  if (eventBus) eventBus.emit({ type: "agent-status", text });
  else if (warn) console.warn(text);
  else console.log(text);
}
