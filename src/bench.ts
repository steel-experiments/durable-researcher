// ABOUTME: Headless CLI bridge for benchmarking — runs a single research task and
// ABOUTME: writes the markdown report to a file. No interactive prompts or task-finding.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createResearchApp } from "./agent.js";
import { getMaxDurationSeconds } from "./config.js";
import type { UsageStats } from "./durable-turns.js";
import type { ResearchParams, ResearchResult } from "./types.js";

function parseArgs(argv: string[]): {
  topic: string;
  output: string;
  usageOutput: string;
  depth: "quick" | "standard" | "deep";
  maxSources: number;
} {
  const args = argv.slice(2);
  let topic = "";
  let output = "";
  let usageOutput = "";
  let depth: "quick" | "standard" | "deep" = "quick";
  let maxSources = 10;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--topic":
        topic = args[++i];
        break;
      case "--output":
        output = args[++i];
        break;
      case "--usage-output":
        usageOutput = args[++i];
        break;
      case "--depth":
        depth = args[++i] as "quick" | "standard" | "deep";
        break;
      case "--max-sources":
        maxSources = parseInt(args[++i], 10);
        break;
    }
  }

  if (!topic || !output) {
    console.error("Usage: bun run src/bench.ts --topic <topic> --output <path> [--usage-output <path>] [--depth quick|standard|deep] [--max-sources N]");
    process.exit(1);
  }

  return { topic, output, usageOutput, depth, maxSources };
}

async function main() {
  const { topic, output, usageOutput, depth, maxSources } = parseArgs(process.argv);

  // Unique queue per invocation so parallel benchmark runs don't race on the
  // same Absurd queue (mirrors createIsolatedQueueName in index.ts).
  const queueName = `bench-${randomUUID()}`;
  const app = createResearchApp({ queueName });

  const params: ResearchParams = { topic, depth, maxSources };
  const { taskID } = await app.spawn("research", params);
  console.error(`Task spawned: ${taskID}`);

  const worker = await app.startWorker({
    concurrency: 1,
    claimTimeout: 600,
    onError: (err: Error) => console.error("Worker error:", err.message),
  });

  const result = await app.awaitTaskResult(taskID, {
    timeout: getMaxDurationSeconds() + 30,
  });

  if (result.state === "completed" && result.result) {
    const research = result.result as unknown as ResearchResult;
    if (research.report) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, research.report, "utf-8");
      console.error(`Report written to: ${output}`);

      // Write a .meta.json sidecar with the resolved mode + verification stats.
      // Lets us audit post-hoc whether the classifier and verification pipeline
      // fired as expected on each benchmark task.
      const metaPath = output.replace(/\.md$/, ".meta.json");
      const meta = {
        mode: research.mode,
        verification: research.verification,
        notes: research.notes?.length ?? 0,
        sources: research.sources?.length ?? 0,
      };
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
      console.error(`Meta written to: ${metaPath} (mode=${research.mode})`);
    } else {
      console.error("Task completed but no report generated.");
      process.exit(1);
    }
  } else if (result.state === "failed") {
    console.error(`Task failed: ${JSON.stringify(result.failure) ?? "unknown error"}`);
    process.exit(1);
  } else {
    console.error(`Task ${result.state}.`);
    process.exit(1);
  }

  const usage = (app as any).getLastUsage?.() as UsageStats | undefined;
  if (usageOutput && usage) {
    mkdirSync(dirname(usageOutput), { recursive: true });
    writeFileSync(usageOutput, `${JSON.stringify(usage, null, 2)}\n`, "utf-8");
    console.error(`Usage written to: ${usageOutput}`);
  }

  await worker.close();
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
