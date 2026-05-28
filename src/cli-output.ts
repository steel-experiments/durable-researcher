// ABOUTME: CLI output helpers for completed and failed research tasks.
// ABOUTME: Keeps presentation, report saving, and usage display out of the entry point.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UsageStats } from "./durable-turns.js";
import { printUsage, saveResearchResult } from "./report-io.js";
import type { ResearchNote, ResearchResult } from "./types.js";

export type CompletedResearchForCli = {
  topic: string;
  report: string;
  sources: { title: string; url: string }[];
  notes: ResearchNote[];
  messages: AgentMessage[];
  explanation?: ResearchResult["explanation"];
  mode?: ResearchResult["mode"];
};

export function printCompletedResearchResult(
  research: CompletedResearchForCli,
  opts: { useTui: boolean; isResume: boolean },
): void {
  if (research.report) {
    const isPartialReport = research.report.startsWith("[Partial results");
    if (opts.useTui || opts.isResume || isPartialReport) {
      console.log("\n" + "=".repeat(80));
      console.log("RESEARCH REPORT");
      console.log("=".repeat(80) + "\n");
      console.log(research.report);
    }
    const saved = saveResearchResult(research as ResearchResult);
    console.log(`\nReport saved to: ${saved.markdownPath}`);
    if (saved.htmlPath) {
      console.log(`HTML artifact saved to: ${saved.htmlPath}`);
    }
  }

  console.log("-".repeat(80));
  console.log(`Sources consulted: ${research.sources.length}`);
}

export function printUsageIfPresent(usage: UsageStats | undefined): void {
  if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
    printUsage(usage);
  }
}

export function printTaskFailure(result: { state: string; failure?: unknown }): void {
  if (result.state === "failed") {
    console.error("\nResearch task failed:", result.failure);
  } else {
    console.error("\nUnexpected task state:", result.state);
  }
}
