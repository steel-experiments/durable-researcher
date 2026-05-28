// ABOUTME: Runtime validation for the versioned HTTP API.
// ABOUTME: Keeps dependencies light while making request contracts explicit.

import { badRequest } from "../service/research-errors.js";
import { normalizeOptimizationGoal, selectHarness, type ResearchHarness } from "../service/research-harness.js";
import type { ResearchRunParams } from "../service/research-runs.js";
import type { CreateResearchRunRequest } from "./types.js";

const DEPTHS = new Set(["quick", "standard", "deep"]);
const MODES = new Set(["lookup", "extraction", "synthesis", "survey"]);
const HARNESS_TYPES = new Set([
  "auto",
  "single_agent",
  "campaign_pulses",
  "fixed_team",
  "async_subagents",
  "orchestrator_blocking_subagents",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw badRequest(`${field} must be a positive number`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number | undefined {
  const n = positiveNumber(value, field);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) throw badRequest(`${field} must be an integer`);
  return n;
}

function parseHarness(value: unknown): ResearchHarness | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw badRequest("harness must be an object");
  const type = value.type;
  if (typeof type !== "string" || !HARNESS_TYPES.has(type)) {
    throw badRequest("harness.type is invalid");
  }
  switch (type) {
    case "auto":
    case "single_agent":
    case "campaign_pulses":
      return { type };
    case "fixed_team":
      return {
        type,
        agents: positiveInteger(value.agents, "harness.agents") ?? 5,
        perAgentTokenLimit: positiveInteger(value.perAgentTokenLimit, "harness.perAgentTokenLimit"),
        totalTokenLimit: positiveInteger(value.totalTokenLimit, "harness.totalTokenLimit"),
      };
    case "async_subagents":
    case "orchestrator_blocking_subagents":
      return {
        type,
        maxSubagents: positiveInteger(value.maxSubagents, "harness.maxSubagents") ?? 5,
        perSubagentTokenLimit: positiveInteger(value.perSubagentTokenLimit, "harness.perSubagentTokenLimit"),
        totalTokenLimit: positiveInteger(value.totalTokenLimit, "harness.totalTokenLimit"),
      };
  }
}

export function validateCreateResearchRunRequest(value: unknown): CreateResearchRunRequest {
  if (!isRecord(value)) throw badRequest("Request body must be a JSON object");
  const topic = value.topic;
  if (typeof topic !== "string" || topic.trim() === "") {
    throw badRequest("topic is required");
  }

  const depth = value.depth;
  if (depth !== undefined && (typeof depth !== "string" || !DEPTHS.has(depth))) {
    throw badRequest("depth must be one of quick, standard, deep");
  }

  const pulseDepth = value.pulseDepth;
  if (pulseDepth !== undefined && (typeof pulseDepth !== "string" || !DEPTHS.has(pulseDepth))) {
    throw badRequest("pulseDepth must be one of quick, standard, deep");
  }

  const mode = value.mode;
  if (mode !== undefined && (typeof mode !== "string" || !MODES.has(mode))) {
    throw badRequest("mode must be one of lookup, extraction, synthesis, survey");
  }

  const budgetsValue = value.budgets ?? {};
  if (!isRecord(budgetsValue)) throw badRequest("budgets must be an object");
  const budgets = {
    maxDurationMs: positiveInteger(budgetsValue.maxDurationMs, "budgets.maxDurationMs"),
    maxTokens: positiveInteger(budgetsValue.maxTokens, "budgets.maxTokens"),
    maxCostUsd: positiveNumber(budgetsValue.maxCostUsd, "budgets.maxCostUsd"),
    maxSources: positiveInteger(budgetsValue.maxSources, "budgets.maxSources"),
    finalizationReserveRatio: positiveNumber(budgetsValue.finalizationReserveRatio, "budgets.finalizationReserveRatio"),
  };

  const pulseMaxSources = positiveInteger(value.pulseMaxSources, "pulseMaxSources");
  const optimizeFor = normalizeOptimizationGoal(value.optimizeFor);
  const harness = parseHarness(value.harness);
  const selectedHarness = selectHarness(harness, optimizeFor);
  const clarify = value.clarify;
  if (clarify !== undefined && typeof clarify !== "string") {
    throw badRequest("clarify must be a string");
  }

  for (const field of ["stopWhenGoalMet", "stopWhenExhaustedSources"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw badRequest(`${field} must be a boolean`);
    }
  }

  return {
    topic: topic.trim(),
    depth: depth as ResearchRunParams["depth"],
    pulseDepth: pulseDepth as ResearchRunParams["pulseDepth"],
    pulseMaxSources,
    mode: mode as ResearchRunParams["mode"],
    clarify,
    optimizeFor,
    harness: harness ?? selectedHarness,
    selectedHarness,
    budgets,
    stopWhenGoalMet: value.stopWhenGoalMet as boolean | undefined,
    stopWhenExhaustedSources: value.stopWhenExhaustedSources as boolean | undefined,
  };
}

export function parseLimit(value: string | null): number {
  if (!value) return 20;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    throw badRequest("limit must be an integer between 1 and 100");
  }
  return n;
}

export function parseNonNegativeInteger(value: string | null, field: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw badRequest(`${field} must be a non-negative integer`);
  }
  return n;
}
