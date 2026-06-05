// ABOUTME: Tests for the carry-forward synthesis-input builder — confirmed answers,
// ABOUTME: a refuted-for-transparency block, and confidence derived from vote arithmetic.

import { describe, expect, it } from "vitest";
import { createResearchLedger, recordClaimsInLedger } from "../src/ledger.js";
import { rankAnswerHypotheses } from "../src/answer-hypotheses.js";
import { buildCarryForwardSynthesis } from "../src/carry-forward-synthesis.js";
import type { ResolvedAnswer } from "../src/types.js";

function bubbleGumLedger() {
  const ledger = createResearchLedger([
    { id: "answer", question: "What 5K had 'bubble gum' in its title?", status: "open", claimIds: [] },
  ]);
  recordClaimsInLedger(ledger, [
    {
      text: "The race was the Bubba Gump Run Forrest Run 5K.",
      sourceUrl: "https://yelp.com/e",
      excerpt: "Bubba Gump Shrimp Company's Run Forrest Run 5K at California's Great America.",
      tier: "secondary",
      requiredClaimIds: ["answer"],
    },
    {
      text: "The race was the Bubba Gump Run Forrest Run 5K.",
      sourceUrl: "https://bubbagump.com/e",
      excerpt: "Our annual Run Forrest Run 5K benefits United Way.",
      tier: "secondary",
      requiredClaimIds: ["answer"],
    },
    {
      text: "The race title literally contains the words 'bubble gum'.",
      sourceUrl: "https://wordplays.com/x",
      excerpt: "5K race 'bubble gum' Great America crossword clue.",
      tier: "unreliable",
      requiredClaimIds: ["answer"],
    },
  ]);
  return ledger;
}

describe("buildCarryForwardSynthesis", () => {
  it("leads with the confirmed answer and lists refuted answers for transparency", () => {
    const ledger = bubbleGumLedger();
    const ranked = rankAnswerHypotheses(ledger, "answer");
    const resolved: ResolvedAnswer[] = ranked.map((h) => ({
      hypothesis: h,
      validVotes: 3,
      refutations: h.answer.includes("literally") ? 3 : 0,
      refuted: h.answer.includes("literally"),
      votes: [],
    }));

    const out = buildCarryForwardSynthesis({ question: "What 5K had 'bubble gum' in its title?", resolved, ledger });

    expect(out.leadAnswer).toBe("The race was the Bubba Gump Run Forrest Run 5K.");
    expect(out.prompt).toMatch(/Confirmed answer/i);
    expect(out.prompt).toContain("Bubba Gump Run Forrest Run 5K");
    // Refuted block present, labelled for transparency, with the vote tally.
    expect(out.prompt).toMatch(/refuted|transparency/i);
    expect(out.prompt).toContain("literally contains the words 'bubble gum'");
    expect(out.prompt).toMatch(/3\s*\/\s*3/);
  });

  it("carries the refuted claim's EVIDENCE forward (the conclusion rides on the evidence)", () => {
    const ledger = bubbleGumLedger();
    const ranked = rankAnswerHypotheses(ledger, "answer");
    const resolved: ResolvedAnswer[] = ranked.map((h) => ({
      hypothesis: h,
      validVotes: 3,
      refutations: h.answer.includes("literally") ? 3 : 0,
      refuted: h.answer.includes("literally"),
      votes: [],
    }));
    const out = buildCarryForwardSynthesis({ question: "q", resolved, ledger });
    // The confirmed answer's grounding excerpts must be present.
    expect(out.prompt).toContain("Run Forrest Run 5K at California's Great America");
  });

  it("recommends MEDIUM confidence when a competing framing was refuted (genuine contention)", () => {
    const ledger = bubbleGumLedger();
    const ranked = rankAnswerHypotheses(ledger, "answer");
    const resolved: ResolvedAnswer[] = ranked.map((h) => ({
      hypothesis: h,
      validVotes: 3,
      refutations: h.answer.includes("literally") ? 3 : 0,
      refuted: h.answer.includes("literally"),
      votes: [],
    }));
    const out = buildCarryForwardSynthesis({ question: "q", resolved, ledger });
    expect(out.recommendedConfidence).toBe("medium");
    expect(out.prompt).toMatch(/medium/i);
  });

  it("recommends HIGH confidence for a clean, well-corroborated answer with no refuted competitor", () => {
    const ledger = createResearchLedger([
      { id: "answer", question: "q", status: "open", claimIds: [] },
    ]);
    recordClaimsInLedger(ledger, [
      { text: "X is the answer.", sourceUrl: "https://a.gov", excerpt: "official: X.", tier: "primary", requiredClaimIds: ["answer"] },
      { text: "X is the answer.", sourceUrl: "https://b.org", excerpt: "X confirmed.", tier: "secondary", requiredClaimIds: ["answer"] },
    ]);
    const ranked = rankAnswerHypotheses(ledger, "answer");
    const resolved: ResolvedAnswer[] = ranked.map((h) => ({ hypothesis: h, validVotes: 3, refutations: 0, refuted: false, votes: [] }));
    const out = buildCarryForwardSynthesis({ question: "q", resolved, ledger });
    expect(out.recommendedConfidence).toBe("high");
  });

  it("recommends LOW confidence and flags inconclusive when every answer was refuted", () => {
    const ledger = bubbleGumLedger();
    const ranked = rankAnswerHypotheses(ledger, "answer");
    const resolved: ResolvedAnswer[] = ranked.map((h) => ({ hypothesis: h, validVotes: 3, refutations: 3, refuted: true, votes: [] }));
    const out = buildCarryForwardSynthesis({ question: "q", resolved, ledger });
    expect(out.leadAnswer).toBeUndefined();
    expect(out.recommendedConfidence).toBe("low");
    expect(out.prompt).toMatch(/inconclusive|no confirmed/i);
  });
});
