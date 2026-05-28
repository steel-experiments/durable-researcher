// ABOUTME: Tests for selecting and validating research execution harnesses.
// ABOUTME: Locks the public quality/latency/cost tradeoff contract.

import { describe, expect, it } from "vitest";
import {
  normalizeOptimizationGoal,
  selectHarness,
  validateExecutableHarness,
} from "../src/service/research-harness.js";

describe("research harness selection", () => {
  it("defaults to campaign pulses for balanced research", () => {
    expect(selectHarness(undefined, undefined)).toEqual({ type: "campaign_pulses" });
    expect(selectHarness({ type: "auto" }, "balanced")).toEqual({ type: "campaign_pulses" });
  });

  it("maps optimization goals to explicit harness defaults", () => {
    expect(selectHarness({ type: "auto" }, "cost")).toEqual({ type: "single_agent" });
    expect(selectHarness({ type: "auto" }, "latency")).toEqual({ type: "fixed_team", agents: 5 });
    expect(selectHarness({ type: "auto" }, "quality")).toEqual({
      type: "orchestrator_blocking_subagents",
      maxSubagents: 5,
    });
  });

  it("preserves an explicit executable harness over optimizeFor", () => {
    expect(selectHarness({ type: "fixed_team", agents: 3 }, "quality")).toEqual({
      type: "fixed_team",
      agents: 3,
    });
  });

  it("rejects invalid harness counts and optimization goals", () => {
    expect(() => validateExecutableHarness({ type: "fixed_team", agents: 0 })).toThrow(/harness\.agents/);
    expect(() => validateExecutableHarness({
      type: "async_subagents",
      maxSubagents: 2,
      perSubagentTokenLimit: -1,
    })).toThrow(/harness\.perSubagentTokenLimit/);
    expect(() => normalizeOptimizationGoal("speed")).toThrow(/optimizeFor/);
  });
});
