// ABOUTME: Tests for ranking candidate answer hypotheses from a pooled fan-out ledger
// ABOUTME: and deciding whether the top hypothesis needs Stage-2 full-agent escalation.

import { describe, expect, it } from "vitest";
import { createResearchLedger, recordClaimsInLedger } from "../src/ledger.js";
import {
  rankAnswerHypotheses,
  decideEscalation,
} from "../src/answer-hypotheses.js";

function ledgerWithAnswer() {
  const ledger = createResearchLedger([
    { id: "answer", question: "What was the race name?", status: "open", claimIds: [] },
  ]);
  return ledger;
}

describe("rankAnswerHypotheses", () => {
  it("returns claims linked to the answer required-claim, ranked by corroboration", () => {
    const ledger = ledgerWithAnswer();
    // Weak: one source.
    recordClaimsInLedger(ledger, [
      { text: "The race was the Mission City 5K.", sourceUrl: "https://weak.com", excerpt: "Mission City 5K.", tier: "blog", requiredClaimIds: ["answer"] },
    ]);
    // Strong: two independent sources → higher corroboration.
    recordClaimsInLedger(ledger, [
      { text: "The race was the Run Forrest Run 5K.", sourceUrl: "https://a.com", excerpt: "Run Forrest Run 5K at Great America.", tier: "secondary", requiredClaimIds: ["answer"] },
      { text: "The race was the Run Forrest Run 5K.", sourceUrl: "https://b.com", excerpt: "The annual Run Forrest Run 5K.", tier: "secondary", requiredClaimIds: ["answer"] },
    ]);

    const ranked = rankAnswerHypotheses(ledger, "answer");
    expect(ranked).toHaveLength(2);
    expect(ranked[0].answer).toBe("The race was the Run Forrest Run 5K.");
    expect(ranked[0].corroboration).toBeGreaterThanOrEqual(2);
    expect(ranked[1].corroboration).toBe(1);
  });

  it("falls back to all supported claims when no answer required-claim id is given", () => {
    const ledger = createResearchLedger();
    recordClaimsInLedger(ledger, [
      { text: "Claim X.", sourceUrl: "https://a.com", excerpt: "X.", tier: "secondary" },
      { text: "Claim Y.", sourceUrl: "https://b.com", excerpt: "Y.", tier: "primary" },
    ]);
    const ranked = rankAnswerHypotheses(ledger);
    expect(ranked).toHaveLength(2);
  });

  it("breaks corroboration ties by source tier (primary over blog)", () => {
    const ledger = ledgerWithAnswer();
    recordClaimsInLedger(ledger, [
      { text: "Answer from a blog.", sourceUrl: "https://blog.com", excerpt: "blog says.", tier: "blog", requiredClaimIds: ["answer"] },
    ]);
    recordClaimsInLedger(ledger, [
      { text: "Answer from a primary source.", sourceUrl: "https://primary.gov", excerpt: "official record.", tier: "primary", requiredClaimIds: ["answer"] },
    ]);
    const ranked = rankAnswerHypotheses(ledger, "answer");
    expect(ranked[0].answer).toBe("Answer from a primary source.");
    expect(ranked[0].bestTier).toBe("primary");
  });
});

describe("decideEscalation", () => {
  const strong = { id: "c1", answer: "X", corroboration: 3, bestTier: "primary" as const, claimIds: ["c1"] };
  const weakCorroboration = { id: "c2", answer: "Y", corroboration: 1, bestTier: "secondary" as const, claimIds: ["c2"] };
  const weakTier = { id: "c3", answer: "Z", corroboration: 2, bestTier: "unreliable" as const, claimIds: ["c3"] };

  it("does not escalate when the top hypothesis is well-corroborated by a strong source", () => {
    expect(decideEscalation([strong]).escalate).toBe(false);
  });

  it("escalates when the top hypothesis has too few independent sources", () => {
    const d = decideEscalation([weakCorroboration]);
    expect(d.escalate).toBe(true);
    expect(d.hypothesis?.id).toBe("c2");
  });

  it("escalates when the top hypothesis rests only on a weak tier", () => {
    expect(decideEscalation([weakTier]).escalate).toBe(true);
  });

  it("escalates when there are no hypotheses at all", () => {
    expect(decideEscalation([]).escalate).toBe(true);
  });

  it("respects a disabled flag (never escalates)", () => {
    expect(decideEscalation([weakCorroboration], { enabled: false }).escalate).toBe(false);
  });
});
