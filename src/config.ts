// ABOUTME: Centralized configuration loaded from environment variables.
// ABOUTME: Provides model, reasoning, and task duration settings.

import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-ai";

/** Parse a "provider:modelId" string into a Model. */
function parseModelString(modelStr: string): Model<Api> {
  const [provider, modelId] = modelStr.split(":");
  if (!provider || !modelId) {
    throw new Error(`Invalid model format "${modelStr}" — expected provider:modelId (e.g. zai:glm-5.1)`);
  }
  return getModel(provider as any, modelId as any);
}

const VALID_REASONING_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh"]);

/** Parse a reasoning effort string, returning undefined if empty/invalid. */
function parseReasoningEffort(value: string | undefined): ThinkingLevel | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (VALID_REASONING_LEVELS.has(trimmed)) return trimmed as ThinkingLevel;
  console.warn(`Invalid reasoning effort "${value}" — valid values: ${[...VALID_REASONING_LEVELS].join(", ")}`);
  return undefined;
}

/** Get the model used for the main agent loop and follow-up. */
export function getAgentModel(cliOverride?: Model<Api>): Model<Api> {
  if (cliOverride) return cliOverride;
  const envModel = process.env.AGENT_MODEL;
  if (envModel) return parseModelString(envModel);
  return getModel("zai", "glm-5.1");
}

/** Get the reasoning effort for the agent loop. */
export function getAgentReasoning(): ThinkingLevel | undefined {
  return parseReasoningEffort(process.env.AGENT_REASONING) ?? "high";
}

let _utilityModelOverride: Model<Api> | undefined;

/** Set the utility model override (used by --model CLI flag to cover both models). */
export function setUtilityModelOverride(model: Model<Api>): void {
  _utilityModelOverride = model;
}

/** Get the model used for utility LLM calls (summarization, planning, fuzzy matching, clarification). */
export function getUtilityModel(): Model<Api> {
  if (_utilityModelOverride) return _utilityModelOverride;
  const envModel = process.env.UTILITY_MODEL;
  if (envModel) return parseModelString(envModel);
  return getModel("zai", "glm-5.1");
}

/** Get the reasoning effort for utility LLM calls. */
export function getUtilityReasoning(): ThinkingLevel | undefined {
  return parseReasoningEffort(process.env.UTILITY_REASONING);
}

/**
 * Per-depth duration ceilings. Deep mode needs more time because it does 4x the
 * sources of quick mode plus the gap/chase loops; the prior flat 20 min cap was
 * sized for the old 20-source ceiling and now truncates deep surveys mid-synthesis.
 */
const DURATION_BY_DEPTH = {
  quick: 1200, // 20 minutes
  standard: 1800, // 30 minutes
  deep: 3600, // 60 minutes
} as const;

/** Depth label accepted by the duration resolver. Mirrors ResearchParams["depth"]. */
type DurationDepth = keyof typeof DURATION_BY_DEPTH;

/**
 * Resolve the max task duration. Precedence: MAX_DURATION env var → per-depth
 * default → deep default (longest, used when depth isn't known yet — e.g. at
 * task registration time, where we want Absurd to allow any depth's runtime).
 */
export function getMaxDurationSeconds(depth?: DurationDepth): number {
  const envVal = process.env.MAX_DURATION;
  if (envVal) {
    const seconds = parseInt(envVal, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds;
    console.warn(`Invalid MAX_DURATION "${envVal}" — falling back to depth default`);
  }
  if (depth && depth in DURATION_BY_DEPTH) return DURATION_BY_DEPTH[depth];
  return DURATION_BY_DEPTH.deep;
}

/** Get the maximum task duration in milliseconds. */
export function getMaxDurationMs(depth?: DurationDepth): number {
  return getMaxDurationSeconds(depth) * 1000;
}

/** Quality-first by default; evals can set SECOND_SYNTHESIS_AUDIT=0 for ablations. */
export function isSecondSynthesisAuditEnabled(): boolean {
  const value = process.env.SECOND_SYNTHESIS_AUDIT;
  if (!value) return true;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

/** Default number of parallel angle workers in the redundant fan-out. */
const DEFAULT_FANOUT_WIDTH = 4;

/**
 * Width of the redundant fan-out (parallel angle workers on the SAME question). Override
 * with FANOUT_WIDTH. Clamped to [1, 8] — 1 disables redundancy, above 8 is diminishing
 * returns for the token cost.
 */
export function getFanoutWidth(): number {
  const value = process.env.FANOUT_WIDTH;
  if (value) {
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(8, n);
    console.warn(`Invalid FANOUT_WIDTH "${value}" — falling back to default`);
  }
  return DEFAULT_FANOUT_WIDTH;
}

/** Whether the Hybrid Stage-2 escalation (one full agent for an unconfirmed top answer) runs. */
export function isFanoutEscalationEnabled(): boolean {
  const value = process.env.FANOUT_ESCALATE;
  if (!value) return true;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
