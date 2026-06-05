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
      type: "redundant_fanout",
      width: 4,
    });
  });

  it("makes the redundant fan-out the deep-depth default", () => {
    expect(selectHarness(undefined, undefined, "deep")).toEqual({ type: "redundant_fanout", width: 4 });
    // Non-deep depths keep the balanced default.
    expect(selectHarness(undefined, undefined, "standard")).toEqual({ type: "campaign_pulses" });
    expect(selectHarness(undefined, "balanced", "quick")).toEqual({ type: "campaign_pulses" });
  });

  it("preserves an explicit harness even at deep depth", () => {
    expect(selectHarness({ type: "single_agent" }, undefined, "deep")).toEqual({ type: "single_agent" });
  });

  it("validates redundant_fanout width and token limits", () => {
    expect(validateExecutableHarness({ type: "redundant_fanout", width: 4 })).toEqual({ type: "redundant_fanout", width: 4 });
    expect(() => validateExecutableHarness({ type: "redundant_fanout", width: 0 })).toThrow(/harness\.width/);
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
