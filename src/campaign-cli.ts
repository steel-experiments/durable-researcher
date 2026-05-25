// ABOUTME: CLI adapter for long-running campaign APIs.
// ABOUTME: Keeps argument parsing separate from the existing single-task CLI path.

import type { CampaignBudgets, CampaignParams } from "./types.js";
import {
  compileCampaignReport,
  createCampaign,
  finalizeCampaign,
  getCampaign,
  listCampaignPulses,
  listCampaigns,
  parseCostBudget,
  parseDurationMs,
  parseTokenBudget,
  pauseCampaign,
  runCampaign,
} from "./campaign.js";
import { saveReport } from "./report-io.js";

export function printCampaignHelp(): void {
  console.log(`
Usage:
  bun run src/index.ts campaign <topic> [options]
  bun run src/index.ts campaign --resume <campaign-id> [--max-pulses N]
  bun run src/index.ts campaign --status <campaign-id>
  bun run src/index.ts campaign --finalize <campaign-id>
  bun run src/index.ts campaign --pause <campaign-id>
  bun run src/index.ts campaign --list

Campaign options:
  --max-duration <N[s|m|h|d|w]>   Wall-clock budget (example: 5d)
  --max-tokens <N[k|m|b]>         Token budget (example: 1b)
  --max-cost <usd>                Estimated dollar budget (example: 500 or $500)
  --max-sources <number>          Campaign-wide source budget
  --pulse-sources <number>        Source budget per pulse (default: 20)
  --depth <quick|standard|deep>   Per-pulse research depth (default: standard)
  --mode <lookup|extraction|synthesis>
  --max-pulses <number>           Safety/testing cap for this CLI invocation

Examples:
  bun run src/index.ts campaign "future of browser agents" --max-duration 5d --max-tokens 1b
  bun run src/index.ts campaign --resume 019d6485-29ae-7484-a08e-659bb5a82b8c
  bun run src/index.ts campaign --status 019d6485-29ae-7484-a08e-659bb5a82b8c
`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function parseCampaignBudgets(args: string[]): CampaignBudgets {
  const budgets: CampaignBudgets = {};
  const duration = valueAfter(args, "--max-duration");
  const tokens = valueAfter(args, "--max-tokens");
  const cost = valueAfter(args, "--max-cost");
  const sources = valueAfter(args, "--max-sources");
  if (duration) budgets.maxDurationMs = parseDurationMs(duration);
  if (tokens) budgets.maxTokens = parseTokenBudget(tokens);
  if (cost) budgets.maxCostUsd = parseCostBudget(cost);
  if (sources) budgets.maxSources = parsePositiveInt(sources, "--max-sources");
  return budgets;
}

function parsePositiveInt(value: string, label: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${label}: ${value}`);
  return n;
}

function parseTopic(args: string[]): string | undefined {
  const flagsWithValues = new Set([
    "--max-duration",
    "--max-tokens",
    "--max-cost",
    "--max-sources",
    "--pulse-sources",
    "--depth",
    "--mode",
    "--max-pulses",
    "--resume",
    "--status",
    "--finalize",
    "--pause",
  ]);
  const skip = new Set<number>();
  args.forEach((arg, i) => {
    if (flagsWithValues.has(arg)) skip.add(i + 1);
  });
  return args.find((arg, i) => !arg.startsWith("--") && !skip.has(i));
}

function printCampaignSummary(campaign: Awaited<ReturnType<typeof getCampaign>> extends infer T ? NonNullable<T> : never): void {
  const spentTokens = campaign.usage.inputTokens + campaign.usage.outputTokens;
  console.log(`${campaign.id}  "${campaign.topic}" [${campaign.status}]`);
  console.log(`  Sources: ${campaign.usage.sources}${campaign.budgets.maxSources ? `/${campaign.budgets.maxSources}` : ""}`);
  console.log(`  Tokens: ${spentTokens.toLocaleString()}${campaign.budgets.maxTokens ? `/${campaign.budgets.maxTokens.toLocaleString()}` : ""}`);
  console.log(`  Est. cost: $${campaign.usage.estimatedCostUsd.toFixed(4)}${campaign.budgets.maxCostUsd ? `/$${campaign.budgets.maxCostUsd}` : ""}`);
  if (campaign.deadlineAt) console.log(`  Deadline: ${campaign.deadlineAt.toISOString()}`);
  if (campaign.stopReason) console.log(`  Stop reason: ${campaign.stopReason}`);
}

export async function runCampaignCli(rawArgs: string[]): Promise<void> {
  const args = rawArgs.slice(1); // strip "campaign"
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printCampaignHelp();
    return;
  }

  if (args.includes("--list")) {
    const campaigns = await listCampaigns();
    if (campaigns.length === 0) {
      console.log("No campaigns found.");
      return;
    }
    for (const campaign of campaigns) printCampaignSummary(campaign);
    return;
  }

  const statusId = valueAfter(args, "--status");
  if (statusId) {
    const campaign = await getCampaign(statusId);
    if (!campaign) throw new Error(`Campaign not found: ${statusId}`);
    printCampaignSummary(campaign);
    const pulses = await listCampaignPulses(statusId);
    if (pulses.length > 0) {
      console.log("\nPulses:");
      for (const pulse of pulses) {
        const decision = pulse.decision ? ` → ${pulse.decision.decision}: ${pulse.decision.reason}` : "";
        console.log(`  #${pulse.pulseIndex + 1} [${pulse.status}] ${pulse.objective}${decision}`);
      }
    }
    return;
  }

  const pauseId = valueAfter(args, "--pause");
  if (pauseId) {
    await pauseCampaign(pauseId);
    console.log(`Paused campaign: ${pauseId}`);
    return;
  }

  const finalizeId = valueAfter(args, "--finalize");
  if (finalizeId) {
    const report = await finalizeCampaign(finalizeId, "manual finalization requested");
    const campaign = await getCampaign(finalizeId);
    const filepath = saveReport(campaign?.topic ?? finalizeId, report);
    console.log(`Final report saved to: ${filepath}`);
    return;
  }

  const resumeId = valueAfter(args, "--resume");
  const maxPulsesRaw = valueAfter(args, "--max-pulses");
  const maxPulses = maxPulsesRaw ? parsePositiveInt(maxPulsesRaw, "--max-pulses") : undefined;

  if (resumeId) {
    console.log(`Resuming campaign: ${resumeId}`);
    const campaign = await runCampaign(resumeId, { maxPulses, quiet: false });
    printCampaignSummary(campaign);
    if (campaign.status === "completed" && campaign.finalReport) {
      const filepath = saveReport(campaign.topic, campaign.finalReport);
      console.log(`Final report saved to: ${filepath}`);
    }
    return;
  }

  const topic = parseTopic(args);
  if (!topic) throw new Error("No campaign topic provided.");

  const depth = (valueAfter(args, "--depth") ?? "standard") as CampaignParams["depth"];
  if (!["quick", "standard", "deep"].includes(depth ?? "")) {
    throw new Error(`Invalid --depth: ${depth}`);
  }
  const modeRaw = valueAfter(args, "--mode");
  if (modeRaw && !["lookup", "extraction", "synthesis"].includes(modeRaw)) {
    throw new Error(`Invalid --mode: ${modeRaw}`);
  }
  const pulseSourcesRaw = valueAfter(args, "--pulse-sources");
  const params: CampaignParams = {
    topic,
    depth,
    pulseDepth: depth,
    pulseMaxSources: pulseSourcesRaw ? parsePositiveInt(pulseSourcesRaw, "--pulse-sources") : undefined,
    mode: modeRaw as CampaignParams["mode"] | undefined,
    budgets: parseCampaignBudgets(args),
    stopWhenGoalMet: true,
    stopWhenExhaustedSources: true,
  };

  const campaign = await createCampaign(params);
  console.log(`Campaign created: ${campaign.id}`);
  printCampaignSummary(campaign);
  const finished = await runCampaign(campaign.id, { maxPulses, quiet: false });
  printCampaignSummary(finished);
  if (finished.status === "completed") {
    const report = finished.finalReport ?? await compileCampaignReport(finished.id);
    const filepath = saveReport(finished.topic, report);
    console.log(`Final report saved to: ${filepath}`);
  }
}
