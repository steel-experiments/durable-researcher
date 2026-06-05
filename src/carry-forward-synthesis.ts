// ABOUTME: Build the synthesis input from adversarially-resolved answers — confirmed
// ABOUTME: answers plus a refuted-for-transparency block whose evidence carries forward.

import { supportingExcerptsForClaims } from "./ledger.js";
import type { Confidence, ResearchLedger, ResolvedAnswer, SourceTier } from "./types.js";

export type CarryForwardSynthesis = {
  /** Full synthesis instruction/context block to feed the synthesizer. */
  prompt: string;
  /** Recommended confidence for the lead answer, from vote arithmetic + corroboration. */
  recommendedConfidence: Confidence;
  /** The surviving (non-refuted), best-corroborated answer, if any. */
  leadAnswer?: string;
};

const STRONG_TIERS: ReadonlySet<SourceTier> = new Set<SourceTier>(["primary", "secondary"]);

function evidenceLines(ledger: ResearchLedger, claimIds: string[]): string[] {
  return supportingExcerptsForClaims(ledger, claimIds)
    .slice(0, 6)
    .map((e) => `    - "${e.text}" — ${e.sourceUrl}`);
}

/**
 * Assemble the carry-forward synthesis input. Confirmed answers (survived the adversarial
 * answer-correctness pass) lead. Refuted answers are NOT discarded — they appear under a
 * transparency block WITH their backing evidence, because the real conclusion frequently
 * rides on the evidence of a refuted framing: "the title literally says bubble gum" dies
 * 3/3, but its (and the survivors') evidence names the Bubba Gump / Run Forrest Run race
 * that is the true answer. Confidence is the literal arithmetic of the votes: a clean
 * well-corroborated answer with no refuted competitor is high; genuine contention (a
 * refuted competing framing, weak tier, or thin corroboration) caps at medium; nothing
 * confirmed is low + inconclusive.
 */
export function buildCarryForwardSynthesis(input: {
  question: string;
  resolved: ResolvedAnswer[];
  ledger: ResearchLedger;
}): CarryForwardSynthesis {
  const confirmed = input.resolved
    .filter((r) => !r.refuted)
    .sort((a, b) => b.hypothesis.corroboration - a.hypothesis.corroboration);
  const refuted = input.resolved.filter((r) => r.refuted);
  const lead = confirmed[0];

  const lines: string[] = [`## Question`, input.question, ``];

  if (confirmed.length > 0) {
    lines.push(`## Confirmed answer(s) — survived adversarial answer-correctness check`);
    for (const r of confirmed) {
      const tier = r.hypothesis.bestTier ?? "unknown";
      lines.push(
        `- "${r.hypothesis.answer}" (independent corroboration=${r.hypothesis.corroboration}, tier=${tier}, refuted ${r.refutations}/${r.validVotes} votes)`,
      );
      lines.push(...evidenceLines(input.ledger, r.hypothesis.claimIds));
    }
    lines.push(``);
  } else {
    lines.push(
      `## No confirmed answer`,
      `Every candidate answer was refuted on the answer-correctness axis. Treat the result as INCONCLUSIVE; do not assert any candidate as the answer.`,
      ``,
    );
  }

  if (refuted.length > 0) {
    lines.push(
      `## Contested / refuted claims (for transparency)`,
      `Do NOT assert these as the answer. Their EVIDENCE may still point to the real answer — read it for clues (a refuted literal framing often carries the true, lateral answer in its sources).`,
    );
    for (const r of refuted) {
      lines.push(`- "${r.hypothesis.answer}" (refuted ${r.refutations}/${r.validVotes} votes)`);
      lines.push(...evidenceLines(input.ledger, r.hypothesis.claimIds));
    }
    lines.push(``);
  }

  const recommendedConfidence = recommendConfidence(lead, refuted.length > 0);

  lines.push(
    `## Synthesis instructions`,
    confirmed.length > 0
      ? `Lead with the confirmed answer in the first sentence. Assign ${recommendedConfidence} confidence — this is the arithmetic of the verification votes, not a stylistic choice.`
      : `State plainly that the question could not be answered with confidence; summarize what was ruled out.`,
    `If a literal framing was refuted but its evidence points to a different real answer (e.g. a homophone or mishearing), state the real answer and explain the discrepancy explicitly, with a confidence caveat.`,
  );

  return {
    prompt: lines.join("\n"),
    recommendedConfidence,
    ...(lead ? { leadAnswer: lead.hypothesis.answer } : {}),
  };
}

function recommendConfidence(lead: ResolvedAnswer | undefined, hasRefutedCompetitor: boolean): Confidence {
  if (!lead) return "low";
  const strongTier = lead.hypothesis.bestTier ? STRONG_TIERS.has(lead.hypothesis.bestTier) : false;
  const wellCorroborated = lead.hypothesis.corroboration >= 2;
  // A refuted competing framing means the question was genuinely contended — even a solid
  // surviving answer should not be asserted at full confidence (the deep-research lesson).
  if (wellCorroborated && strongTier && !hasRefutedCompetitor) return "high";
  if (wellCorroborated || strongTier) return "medium";
  return "low";
}
