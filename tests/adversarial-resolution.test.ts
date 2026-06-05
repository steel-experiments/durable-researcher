// ABOUTME: Tests for the adversarial answer-correctness pass — N skeptic votes per
// ABOUTME: hypothesis, quorum kill, abstention handling, and carry-forward retention.

import { describe, expect, it } from "vitest";
import { createResearchLedger, recordClaimsInLedger } from "../src/ledger.js";
import { rankAnswerHypotheses } from "../src/answer-hypotheses.js";
import {
  resolveAnswerClaims,
  type AnswerCorrectnessVoter,
} from "../src/adversarial-resolution.js";
import type { AnswerHypothesis } from "../src/types.js";

const hyp = (over: Partial<AnswerHypothesis> = {}): AnswerHypothesis => ({
  id: "c1",
  answer: "The race title literally contains the words 'bubble gum'.",
  corroboration: 1,
  bestTier: "secondary",
  claimIds: ["c1"],
  ...over,
});

describe("resolveAnswerClaims", () => {
  it("kills a hypothesis when a quorum of skeptics refutes it (answer-correctness axis)", async () => {
    // The literal-title claim: grounded facts exist, but as an ANSWER it is wrong.
    const voter: AnswerCorrectnessVoter = async () => ({ refuted: true, reason: "Bubba Gump is a Forrest Gump reference, not 'bubble gum'." });
    const [resolved] = await resolveAnswerClaims({
      question: "What 5K had 'bubble gum' in its title?",
      hypotheses: [hyp()],
      ledger: createResearchLedger(),
      voter,
      votesPerClaim: 3,
      refutationsRequired: 2,
    });
    expect(resolved.validVotes).toBe(3);
    expect(resolved.refutations).toBe(3);
    expect(resolved.refuted).toBe(true);
  });

  it("keeps a hypothesis the skeptics cannot refute (3-0 survive)", async () => {
    const voter: AnswerCorrectnessVoter = async () => ({ refuted: false, reason: "Directly answers the question." });
    const [resolved] = await resolveAnswerClaims({
      question: "q",
      hypotheses: [hyp({ answer: "The race was the Run Forrest Run 5K." })],
      ledger: createResearchLedger(),
      voter,
    });
    expect(resolved.refuted).toBe(false);
    expect(resolved.refutations).toBe(0);
  });

  it("does not kill on a single dissent below quorum (1 of 3)", async () => {
    let n = 0;
    const voter: AnswerCorrectnessVoter = async () => ({ refuted: n++ === 0, reason: "" });
    const [resolved] = await resolveAnswerClaims({
      question: "q",
      hypotheses: [hyp()],
      ledger: createResearchLedger(),
      voter,
      votesPerClaim: 3,
      refutationsRequired: 2,
    });
    expect(resolved.refutations).toBe(1);
    expect(resolved.refuted).toBe(false);
  });

  it("treats voter errors as abstentions that never count toward the quorum", async () => {
    // Two votes throw (abstain), one refutes. With refutationsRequired=2 and only 1 valid
    // refutation, the claim must NOT be killed on our own infra noise.
    let n = 0;
    const voter: AnswerCorrectnessVoter = async () => {
      if (n++ < 2) throw new Error("LLM timeout");
      return { refuted: true, reason: "late refutation" };
    };
    const [resolved] = await resolveAnswerClaims({
      question: "q",
      hypotheses: [hyp()],
      ledger: createResearchLedger(),
      voter,
      votesPerClaim: 3,
      refutationsRequired: 2,
    });
    expect(resolved.validVotes).toBe(1);
    expect(resolved.refutations).toBe(1);
    expect(resolved.refuted).toBe(false);
  });

  it("retains every hypothesis (carry-forward) regardless of verdict", async () => {
    const voter: AnswerCorrectnessVoter = async ({ candidateAnswer }) => ({
      refuted: candidateAnswer.includes("bubble gum"),
      reason: "",
    });
    const resolved = await resolveAnswerClaims({
      question: "q",
      hypotheses: [
        hyp({ id: "kill", answer: "title literally contains 'bubble gum'" }),
        hyp({ id: "keep", answer: "the race was the Run Forrest Run 5K" }),
      ],
      ledger: createResearchLedger(),
      voter,
    });
    expect(resolved).toHaveLength(2);
    expect(resolved.find((r) => r.hypothesis.id === "kill")?.refuted).toBe(true);
    expect(resolved.find((r) => r.hypothesis.id === "keep")?.refuted).toBe(false);
  });

  it("passes the hypothesis's backing excerpts to the voter", async () => {
    const ledger = createResearchLedger([
      { id: "answer", question: "race?", status: "open", claimIds: [] },
    ]);
    recordClaimsInLedger(ledger, [
      { text: "The race was the Run Forrest Run 5K.", sourceUrl: "https://a.com", excerpt: "Run Forrest Run 5K at Great America.", tier: "secondary", requiredClaimIds: ["answer"] },
    ]);
    const seen: string[][] = [];
    const voter: AnswerCorrectnessVoter = async ({ excerpts }) => {
      seen.push(excerpts);
      return { refuted: false, reason: "" };
    };
    const hypotheses = rankAnswerHypotheses(ledger, "answer");
    await resolveAnswerClaims({ question: "q", hypotheses, ledger, voter, votesPerClaim: 1 });
    expect(seen[0]).toContain("Run Forrest Run 5K at Great America.");
  });
});
