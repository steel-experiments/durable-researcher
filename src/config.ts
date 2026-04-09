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

/** Get the model used for utility LLM calls (summarization, planning, fuzzy matching, clarification). */
export function getUtilityModel(): Model<Api> {
  const envModel = process.env.UTILITY_MODEL;
  if (envModel) return parseModelString(envModel);
  return getModel("zai", "glm-5.1");
}

/** Get the reasoning effort for utility LLM calls. */
export function getUtilityReasoning(): ThinkingLevel | undefined {
  return parseReasoningEffort(process.env.UTILITY_REASONING);
}

/** Default max task duration in seconds. */
const DEFAULT_MAX_DURATION_SECONDS = 1200; // 20 minutes

/** Get the maximum task duration in seconds. */
export function getMaxDurationSeconds(): number {
  const envVal = process.env.MAX_DURATION;
  if (envVal) {
    const seconds = parseInt(envVal, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds;
    console.warn(`Invalid MAX_DURATION "${envVal}" — using default ${DEFAULT_MAX_DURATION_SECONDS}s`);
  }
  return DEFAULT_MAX_DURATION_SECONDS;
}

/** Get the maximum task duration in milliseconds. */
export function getMaxDurationMs(): number {
  return getMaxDurationSeconds() * 1000;
}
