// ABOUTME: Tests for the post-synthesis completeness critic.
// ABOUTME: Uses an injected critic stub so no real LLM calls are made.

import { describe, it, expect } from "vitest";
import { critiqueCompleteness } from "../../src/service/completeness-critic.js";

describe("critiqueCompleteness", () => {
  it("passes through the critic's structured verdict", async () => {
    const critique = await critiqueCompleteness({
      topic: "T",
      report: "A full report with content.",
      objectives: ["angle one", "angle two"],
      critic: async () => ({
        coverageComplete: false,
        gaps: ["  No criticism covered  ", "Timeline missing", ""],
      }),
    });
    expect(critique.coverageComplete).toBe(false);
    // Trims and drops empties.
    expect(critique.gaps).toEqual(["No criticism covered", "Timeline missing"]);
  });

  it("does not block when the critic returns null (parse/infra failure)", async () => {
    const critique = await critiqueCompleteness({
      topic: "T",
      report: "A full report.",
      objectives: [],
      critic: async () => null,
    });
    expect(critique.coverageComplete).toBe(true);
    expect(critique.gaps).toEqual([]);
  });

  it("does not block when the critic throws", async () => {
    const critique = await critiqueCompleteness({
      topic: "T",
      report: "A full report.",
      objectives: [],
      critic: async () => {
        throw new Error("boom");
      },
    });
    expect(critique.coverageComplete).toBe(true);
    expect(critique.gaps).toEqual([]);
  });

  it("flags an empty report without calling the critic", async () => {
    let called = false;
    const critique = await critiqueCompleteness({
      topic: "T",
      report: "   ",
      objectives: [],
      critic: async () => {
        called = true;
        return null;
      },
    });
    expect(called).toBe(false);
    expect(critique.coverageComplete).toBe(false);
    expect(critique.gaps.length).toBeGreaterThan(0);
  });
});
