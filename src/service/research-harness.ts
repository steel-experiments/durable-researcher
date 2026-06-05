// ABOUTME: Harness contract, validation, and default selection for research runs.
// ABOUTME: Makes quality/latency/cost tradeoffs explicit at the service boundary.

import { badRequest } from "./research-errors.js";

export type ResearchOptimizationGoal = "quality" | "latency" | "cost" | "balanced";

export type ResearchHarness =
  | { type: "auto" }
  | { type: "single_agent" }
  | { type: "campaign_pulses" }
  | {
      type: "fixed_team";
      agents: number;
      perAgentTokenLimit?: number;
      totalTokenLimit?: number;
    }
  | {
      type: "async_subagents";
      maxSubagents: number;
      perSubagentTokenLimit?: number;
      totalTokenLimit?: number;
    }
  | {
      type: "orchestrator_blocking_subagents";
      maxSubagents: number;
      perSubagentTokenLimit?: number;
      totalTokenLimit?: number;
    }
  | {
      /**
       * Redundant fan-out: N parallel angle workers on the SAME question (one per
       * interpretation), pooled into one ledger, then adversarial answer-correctness
       * resolution + carry-forward synthesis. The anti-self-rejection / convergence
       * harness — the deep-depth default.
       */
      type: "redundant_fanout";
      width: number;
      perWorkerTokenLimit?: number;
      totalTokenLimit?: number;
    };

export type ExecutableHarness = Exclude<ResearchHarness, { type: "auto" }>;

const DEFAULT_FIXED_TEAM_AGENTS = 5;
const DEFAULT_SUBAGENTS = 5;
const DEFAULT_FANOUT_WIDTH = 4;

function assertPositiveInteger(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw badRequest(`${field} must be a positive integer`);
  }
}

export function selectHarness(
  harness: ResearchHarness | undefined,
  optimizeFor: ResearchOptimizationGoal | undefined,
  depth?: "quick" | "standard" | "deep",
): ExecutableHarness {
  if (harness && harness.type !== "auto") {
    return validateExecutableHarness(harness);
  }

  // Quality goal gets the redundant fan-out (the most thorough harness).
  if (optimizeFor === "quality") {
    return { type: "redundant_fanout", width: DEFAULT_FANOUT_WIDTH };
  }

  switch (optimizeFor) {
    case "cost":
      return { type: "single_agent" };
    case "latency":
      return { type: "fixed_team", agents: DEFAULT_FIXED_TEAM_AGENTS };
    case "balanced":
    case undefined:
      // Deep-depth default is the redundant fan-out: parallel readings beat a lone
      // reasoner's self-rejection, and adversarial carry-forward keeps the answer honest.
      if (depth === "deep") return { type: "redundant_fanout", width: DEFAULT_FANOUT_WIDTH };
      return { type: "campaign_pulses" };
  }
}

export function validateExecutableHarness(harness: ExecutableHarness): ExecutableHarness {
  switch (harness.type) {
    case "single_agent":
    case "campaign_pulses":
      return harness;
    case "fixed_team":
      assertPositiveInteger(harness.agents, "harness.agents");
      assertPositiveInteger(harness.perAgentTokenLimit, "harness.perAgentTokenLimit");
      assertPositiveInteger(harness.totalTokenLimit, "harness.totalTokenLimit");
      return harness;
    case "async_subagents":
    case "orchestrator_blocking_subagents":
      assertPositiveInteger(harness.maxSubagents, "harness.maxSubagents");
      assertPositiveInteger(harness.perSubagentTokenLimit, "harness.perSubagentTokenLimit");
      assertPositiveInteger(harness.totalTokenLimit, "harness.totalTokenLimit");
      return harness;
    case "redundant_fanout":
      assertPositiveInteger(harness.width, "harness.width");
      assertPositiveInteger(harness.perWorkerTokenLimit, "harness.perWorkerTokenLimit");
      assertPositiveInteger(harness.totalTokenLimit, "harness.totalTokenLimit");
      return harness;
  }
}

export function normalizeOptimizationGoal(value: unknown): ResearchOptimizationGoal | undefined {
  if (value === undefined) return undefined;
  if (value === "quality" || value === "latency" || value === "cost" || value === "balanced") {
    return value;
  }
  throw badRequest("optimizeFor must be one of quality, latency, cost, balanced");
}
