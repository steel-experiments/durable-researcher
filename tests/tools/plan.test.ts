// ABOUTME: Tests for plan response parsing and formatting.
// ABOUTME: Locks that lateral interpretations are carried through and rendered for the agent.

import { describe, it, expect } from "vitest";
import { parsePlanResponse, formatPlan } from "../../src/tools/plan.js";

const PLAN_WITH_INTERPRETATIONS = JSON.stringify({
  interpretations: [
    { reading: "literal", meaning: "face-value meaning", queriesTarget: "literal terms" },
    {
      reading: "lateral",
      device: "homophone",
      meaning: "the decoded phrase that sounds the same",
      queriesTarget: "decoded terms",
    },
  ],
  requiredClaims: [
    { id: "rq1", question: "Identify the answer", status: "open", claimIds: [] },
    { id: "rq2", question: "Verify the premise", status: "open", claimIds: [] },
  ],
  strategicPlan: "Investigate both readings.",
  subQueries: ["query one", "query two"],
  searchStrategy: "mixed",
  estimatedSteps: 4,
});

describe("parsePlanResponse", () => {
  it("carries lateral interpretations through instead of discarding them", () => {
    const plan = parsePlanResponse(PLAN_WITH_INTERPRETATIONS, "some topic", 5);
    expect(plan.interpretations).toBeDefined();
    expect(plan.interpretations).toHaveLength(2);
    expect(plan.interpretations?.[1]).toMatchObject({
      reading: "lateral",
      device: "homophone",
    });
    // Existing fields still parse.
    expect(plan.subQueries).toEqual(["query one", "query two"]);
    expect(plan.strategicPlan).toBe("Investigate both readings.");
    expect(plan.requiredClaims).toHaveLength(2);
    expect(plan.requiredClaims?.[0].question).toBe("Identify the answer");
  });

  it("leaves interpretations undefined when the model omits them", () => {
    const plan = parsePlanResponse(
      JSON.stringify({ strategicPlan: "p", subQueries: ["a", "b"], searchStrategy: "mixed", estimatedSteps: 2 }),
      "topic",
      5,
    );
    expect(plan.interpretations).toBeUndefined();
    expect(plan.subQueries).toEqual(["a", "b"]);
  });

  it("adds quoted title constraints as required claims", () => {
    const plan = parsePlanResponse(
      JSON.stringify({
        strategicPlan: "p",
        subQueries: ["a"],
        searchStrategy: "mixed",
        estimatedSteps: 2,
        requiredClaims: [
          { id: "rq1", question: "Identify the race", status: "open", claimIds: [] },
        ],
      }),
      "What was the 5K race that had 'bubble gum' in its title?",
      5,
    );

    expect(plan.requiredClaims?.map((claim) => claim.question).join("\n")).toContain("bubble gum");
    expect(plan.requiredClaims?.map((claim) => claim.question).join("\n")).toContain("title/name");
  });
});

describe("formatPlan", () => {
  it("renders the interpretations so the agent can see the lateral reasoning", () => {
    const plan = parsePlanResponse(PLAN_WITH_INTERPRETATIONS, "topic", 5);
    const text = formatPlan(plan).join("\n");
    expect(text).toContain("Interpretations");
    expect(text).toContain("homophone");
    expect(text).toContain("the decoded phrase that sounds the same");
    expect(text).toContain("Required Claims");
    expect(text).toContain("Identify the answer");
    // Queries still render.
    expect(text).toContain("query one");
  });

  it("omits the interpretations section entirely when there are none", () => {
    const plan = parsePlanResponse(
      JSON.stringify({ strategicPlan: "p", subQueries: ["a"], searchStrategy: "mixed", estimatedSteps: 2 }),
      "topic",
      5,
    );
    const text = formatPlan(plan).join("\n");
    expect(text).not.toContain("Interpretations");
    expect(text).toContain("a");
  });
});
