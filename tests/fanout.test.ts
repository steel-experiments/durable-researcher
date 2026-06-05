// ABOUTME: Tests for the redundant fan-out orchestration brain — angle generation and
// ABOUTME: the compose of merge -> rank -> escalate -> adversarial resolve -> synthesis.

import { describe, expect, it } from "vitest";
import { createResearchLedger, recordClaimsInLedger } from "../src/ledger.js";
import { interpretationsToAngles, runRedundantFanout } from "../src/fanout.js";
import type { AnswerCorrectnessVoter } from "../src/adversarial-resolution.js";
import type { PlanInterpretation, ResearchLedger } from "../src/types.js";

describe("interpretationsToAngles", () => {
  const interps: PlanInterpretation[] = [
    { reading: "literal", meaning: "a race with 'bubble gum' literally in the name", queriesTarget: "bubble gum 5K" },
    { reading: "lateral", device: "homophone", meaning: "'bubble gum' sounds like 'Bubba Gump'", queriesTarget: "Bubba Gump 5K" },
  ];

  it("maps each interpretation to an angle, capped at width", () => {
    const angles = interpretationsToAngles("q", interps, 5);
    expect(angles).toHaveLength(2);
    expect(angles[0].reading).toBe("literal");
    expect(angles[1].reading).toBe("lateral");
    expect(angles[1].instruction).toContain("Bubba Gump");
  });

  it("embeds the anti-self-rejection directive in every angle", () => {
    const angles = interpretationsToAngles("q", interps, 5);
    for (const a of angles) {
      expect(a.instruction.toLowerCase()).toMatch(/do not (abandon|dismiss|discard)/);
    }
  });

  it("caps the number of angles at the requested width", () => {
    expect(interpretationsToAngles("q", interps, 1)).toHaveLength(1);
  });

  it("falls back to a literal angle when no interpretations are provided", () => {
    const angles = interpretationsToAngles("the only question", undefined, 3);
    expect(angles.length).toBeGreaterThanOrEqual(1);
    expect(angles[0].instruction).toContain("the only question");
  });
});

describe("runRedundantFanout", () => {
  // Each angle worker returns a ledger. The lateral angle finds the real answer; the
  // literal angle finds only the (refutable) literal framing. This is the bubble-gum
  // scenario reproduced at the orchestration layer.
  const QUESTION = "What 5K had 'bubble gum' in its title at Great America?";

  function ledgerFor(reading: string): ResearchLedger {
    const ledger = createResearchLedger([
      { id: "answer", question: QUESTION, status: "open", claimIds: [] },
    ]);
    if (reading === "lateral") {
      recordClaimsInLedger(ledger, [
        { text: "The race was the Bubba Gump Run Forrest Run 5K.", sourceUrl: "https://yelp.com/e", excerpt: "Bubba Gump Shrimp Company's Run Forrest Run 5K at California's Great America.", tier: "secondary", requiredClaimIds: ["answer"] },
      ]);
    } else {
      recordClaimsInLedger(ledger, [
        { text: "The race title literally contains 'bubble gum'.", sourceUrl: "https://wordplays.com/x", excerpt: "5K race 'bubble gum' Great America crossword clue.", tier: "unreliable", requiredClaimIds: ["answer"] },
      ]);
    }
    return ledger;
  }

  const killLiteralVoter: AnswerCorrectnessVoter = async ({ candidateAnswer }) => ({
    refuted: candidateAnswer.includes("literally"),
    reason: candidateAnswer.includes("literally") ? "Bubba Gump is a reference, not literal bubble gum" : "answers the question",
  });

  it("pools angle ledgers, kills the literal framing, and surfaces the real answer", async () => {
    const angles = [
      { reading: "literal", instruction: "literal" },
      { reading: "lateral", instruction: "lateral" },
    ];
    const out = await runRedundantFanout({
      question: QUESTION,
      angles,
      runAngle: async (a) => ledgerFor(a.reading),
      answerRequiredClaimId: "answer",
      escalation: { enabled: false },
      voter: killLiteralVoter,
      votesPerClaim: 3,
      refutationsRequired: 2,
    });

    // Both candidate answers present in the pooled ledger.
    expect(out.ledger.claims).toHaveLength(2);
    // The literal framing was refuted; the lateral answer survived.
    const literal = out.resolved.find((r) => r.hypothesis.answer.includes("literally"));
    const lateral = out.resolved.find((r) => r.hypothesis.answer.includes("Bubba Gump"));
    expect(literal?.refuted).toBe(true);
    expect(lateral?.refuted).toBe(false);
    // Synthesis leads with the surviving answer and carries the refuted one for transparency.
    expect(out.synthesis.leadAnswer).toBe("The race was the Bubba Gump Run Forrest Run 5K.");
    expect(out.synthesis.prompt).toContain("literally contains 'bubble gum'");
  });

  it("acceptance: reproduces deep-research's honest answer shape (medium confidence + caveat)", async () => {
    // The end-to-end acceptance criterion from the plan: on the bubble-gum needle, the
    // fan-out must (a) surface the real answer, (b) kill the literal framing, and (c) land
    // at MEDIUM confidence with the carry-forward caveat — not assert the literal framing,
    // and not over-claim. This mirrors what /deep-research produced.
    const angles = [
      { reading: "literal", instruction: "literal" },
      { reading: "lateral", instruction: "lateral" },
    ];
    const out = await runRedundantFanout({
      question: QUESTION,
      angles,
      runAngle: async (a) => ledgerFor(a.reading),
      answerRequiredClaimId: "answer",
      escalation: { enabled: false },
      voter: killLiteralVoter,
    });
    expect(out.synthesis.recommendedConfidence).toBe("medium");
    // The synthesis prompt must instruct an explicit homophone/discrepancy caveat.
    expect(out.synthesis.prompt.toLowerCase()).toMatch(/homophone|mishearing|discrepancy/);
    // And it must carry the refuted framing's evidence forward, not discard it.
    expect(out.synthesis.prompt).toMatch(/transparency/i);
  });

  it("escalates to a full agent when the top answer is weakly corroborated, then re-pools", async () => {
    // Stage-1 yields only the unreliable literal claim. Escalation injects a strong
    // lateral ledger; after re-pooling the lateral answer should win.
    const calls: string[] = [];
    const out = await runRedundantFanout({
      question: QUESTION,
      angles: [{ reading: "literal", instruction: "literal" }],
      runAngle: async (a) => { calls.push(`angle:${a.reading}`); return ledgerFor(a.reading); },
      answerRequiredClaimId: "answer",
      escalation: { enabled: true },
      runEscalation: async (h) => { calls.push(`escalate:${h.answer}`); return ledgerFor("lateral"); },
      voter: killLiteralVoter,
    });
    expect(out.escalation.escalate).toBe(true);
    expect(calls.some((c) => c.startsWith("escalate:"))).toBe(true);
    // After escalation the pooled ledger has both claims.
    expect(out.ledger.claims.length).toBeGreaterThanOrEqual(2);
    expect(out.synthesis.leadAnswer).toContain("Bubba Gump");
  });

  it("drops angle workers that fail without aborting the whole fan-out", async () => {
    const out = await runRedundantFanout({
      question: QUESTION,
      angles: [
        { reading: "lateral", instruction: "lateral" },
        { reading: "broken", instruction: "broken" },
      ],
      runAngle: async (a) => {
        if (a.reading === "broken") throw new Error("worker crashed");
        return ledgerFor(a.reading);
      },
      answerRequiredClaimId: "answer",
      escalation: { enabled: false },
      voter: killLiteralVoter,
    });
    expect(out.ledger.claims).toHaveLength(1);
    expect(out.synthesis.leadAnswer).toContain("Bubba Gump");
  });
});
