// ABOUTME: Tests pure campaign budget, stop-policy, and report helper behavior.
// ABOUTME: Avoids live DB/LLM calls so campaign policy stays fast to validate.

import { describe, expect, it } from "vitest";
import {
  budgetStopReason,
  emptyCampaignUsage,
  heuristicCampaignDecision,
  mergeCampaignUsage,
  parseCostBudget,
  parseDurationMs,
  parseTokenBudget,
  shouldFinalizeFromDecision,
} from "../src/campaign.js";
import type { CampaignParams, CampaignRecord } from "../src/types.js";

describe("campaign budget parsing", () => {
  it("parses human duration values", () => {
    expect(parseDurationMs("5d")).toBe(5 * 86_400_000);
    expect(parseDurationMs("2h")).toBe(2 * 3_600_000);
    expect(parseDurationMs("30m")).toBe(30 * 60_000);
  });

  it("parses token budgets with suffixes", () => {
    expect(parseTokenBudget("1k")).toBe(1_000);
    expect(parseTokenBudget("2.5m")).toBe(2_500_000);
    expect(parseTokenBudget("1b")).toBe(1_000_000_000);
  });

  it("parses cost budgets with or without a dollar sign", () => {
    expect(parseCostBudget("$500")).toBe(500);
    expect(parseCostBudget("12.50")).toBe(12.5);
  });
});

describe("campaign stop policy", () => {
  const baseCampaign = (): Pick<CampaignRecord, "createdAt" | "deadlineAt" | "usage" | "budgets"> => ({
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deadlineAt: null,
    usage: emptyCampaignUsage(),
    budgets: {},
  });

  it("stops when token budget is exhausted", () => {
    const campaign = baseCampaign();
    campaign.budgets = { maxTokens: 100 };
    campaign.usage = { ...emptyCampaignUsage(), inputTokens: 60, outputTokens: 40 };

    expect(budgetStopReason(campaign)).toBe("token budget exhausted");
  });

  it("reserves budget for finalization before full exhaustion", () => {
    const campaign = baseCampaign();
    campaign.budgets = { maxTokens: 100, finalizationReserveRatio: 0.1 };
    campaign.usage = { ...emptyCampaignUsage(), inputTokens: 80, outputTokens: 11 };

    expect(budgetStopReason(campaign)).toBe("finalization reserve reached");
  });

  it("finalizes when judge says coverage and auditability are high enough", () => {
    const params: CampaignParams = {
      topic: "topic",
      budgets: {},
      stopWhenGoalMet: true,
      stopWhenExhaustedSources: true,
    };

    expect(shouldFinalizeFromDecision(params, {
      decision: "continue",
      reason: "enough",
      coverageScore: 0.9,
      noveltyScore: 0.3,
      auditabilityScore: 0.9,
      remainingGaps: [],
      nextObjective: null,
    })).toBe(true);
  });

  it("finalizes when source novelty collapses", () => {
    const params: CampaignParams = {
      topic: "topic",
      budgets: {},
      stopWhenGoalMet: false,
      stopWhenExhaustedSources: true,
    };

    expect(shouldFinalizeFromDecision(params, {
      decision: "continue",
      reason: "plateau",
      coverageScore: 0.5,
      noveltyScore: 0,
      auditabilityScore: 0.5,
      remainingGaps: ["gap"],
      nextObjective: "try again",
    })).toBe(true);
  });
});

describe("campaign usage and heuristic judging", () => {
  it("merges model usage ledgers", () => {
    const a = {
      ...emptyCampaignUsage(),
      inputTokens: 10,
      models: { m: { input: 10, output: 2 } },
    };
    const b = {
      ...emptyCampaignUsage(),
      outputTokens: 5,
      models: { m: { input: 1, output: 5 }, n: { input: 3, output: 4 } },
    };

    const merged = mergeCampaignUsage(a, b);

    expect(merged.inputTokens).toBe(10);
    expect(merged.outputTokens).toBe(5);
    expect(merged.models.m).toEqual({ input: 11, output: 7 });
    expect(merged.models.n).toEqual({ input: 3, output: 4 });
  });

  it("heuristic judge continues when coverage is still weak", () => {
    const decision = heuristicCampaignDecision({
      pulseIndex: 0,
      notes: [],
      totalSources: 1,
      newSourceCount: 1,
      newNoteCount: 0,
    });

    expect(decision.decision).toBe("continue");
    expect(decision.remainingGaps.length).toBeGreaterThan(0);
  });

  it("heuristic judge treats no-claim verification as low auditability", () => {
    const decision = heuristicCampaignDecision({
      pulseIndex: 1,
      notes: Array.from({ length: 20 }, (_, i) => ({
        title: `Note ${i}`,
        content: "Source-backed finding.",
        sourceUrls: [`https://example.com/${i}`],
        confidence: "high" as const,
        keyExcerpts: ["Source-backed quote."],
      })),
      totalSources: 20,
      newSourceCount: 5,
      newNoteCount: 5,
      verificationPassRate: 0,
      verificationTotal: 0,
      verificationStatus: "no_claims",
    });

    expect(decision.decision).toBe("continue");
    expect(decision.remainingGaps[0]).toMatch(/numeric inline citations/i);
  });
});
