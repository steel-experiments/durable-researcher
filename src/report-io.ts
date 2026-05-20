// ABOUTME: File-system output for finished reports and stdout helpers for the CLI.
// ABOUTME: Pure helpers — no Postgres, no agent state.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { UsageStats } from "./durable-turns.js";

/** Turn a topic string into a filesystem-safe slug, capped at 60 chars. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** Write a report to ./output/<slug>-<timestamp>.md and return the path. */
export function saveReport(topic: string, report: string): string {
  const outputDir = resolve(process.cwd(), "output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${slugify(topic)}-${timestamp}.md`;
  const filepath = resolve(outputDir, filename);
  writeFileSync(filepath, `# ${topic}\n\n${report}\n`);
  return filepath;
}

/** Print a tidy token-usage summary to stdout. */
export function printUsage(usage: UsageStats): void {
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
