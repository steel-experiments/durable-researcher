// ABOUTME: Surface and rank candidate answer hypotheses from a pooled fan-out ledger,
// ABOUTME: and decide whether the top hypothesis needs Stage-2 full-agent escalation.

import type {
  AnswerHypothesis,
  ResearchClaim,
  ResearchLedger,
  SourceTier,
} from "./types.js";

const TIER_RANK: Record<SourceTier, number> = {
  primary: 5,
  secondary: 4,
  blog: 3,
  forum: 2,
  unreliable: 1,
};

/** Minimum independent corroboration for the top hypothesis to be trusted without escalation. */
export const ESCALATE_MIN_CORROBORATION = 2;
/** Source tiers too weak to trust a single-shot answer on; escalate to confirm/refute. */
const WEAK_TIERS: ReadonlySet<SourceTier> = new Set<SourceTier>(["forum", "unreliable"]);

function bestTierOf(ledger: ResearchLedger, claim: ResearchClaim): SourceTier | undefined {
  const tiers = ledger.evidenceLinks
    .filter((link) => link.claimId === claim.id && link.supports)
    .map((link) => link.tier);
  if (tiers.length === 0) return undefined;
  return tiers.sort((a, b) => TIER_RANK[b] - TIER_RANK[a])[0];
}

function toHypothesis(ledger: ResearchLedger, claim: ResearchClaim): AnswerHypothesis {
  return {
    id: claim.id,
    answer: claim.text,
    corroboration: claim.independentCorroboration,
    ...(bestTierOf(ledger, claim) ? { bestTier: bestTierOf(ledger, claim) } : {}),
    claimIds: [claim.id],
  };
}

/**
 * Rank candidate answers from the pooled ledger, best first. When `answerRequiredClaimId`
 * is given, only claims linked to that coverage slot are considered answers (vs supporting
 * facts); otherwise every non-refuted claim is a candidate. Ranking is by independent
 * corroboration (the fan-out convergence signal) then by best source tier.
 */
export function rankAnswerHypotheses(
  ledger: ResearchLedger,
  answerRequiredClaimId?: string,
): AnswerHypothesis[] {
  let claims: ResearchClaim[];
  if (answerRequiredClaimId) {
    const required = ledger.requiredClaims.find((r) => r.id === answerRequiredClaimId);
    const ids = new Set(required?.claimIds ?? []);
    claims = ledger.claims.filter((c) => ids.has(c.id));
  } else {
    claims = ledger.claims.filter((c) => c.status !== "refuted");
  }
  return claims
    .map((claim) => toHypothesis(ledger, claim))
    .sort((a, b) => {
      if (b.corroboration !== a.corroboration) return b.corroboration - a.corroboration;
      const at = a.bestTier ? TIER_RANK[a.bestTier] : 0;
      const bt = b.bestTier ? TIER_RANK[b.bestTier] : 0;
      return bt - at;
    });
}

export type EscalationDecision = {
  escalate: boolean;
  /** The top hypothesis that would be deep-confirmed (undefined when none exist). */
  hypothesis?: AnswerHypothesis;
  reason: string;
};

/**
 * Decide whether Stage-2 escalation (one full research agent) is warranted. The Hybrid
 * fan-out spends a full agent only when the cheap search-angle pass left the top answer
 * unconfirmed — too few independent sources, or resting only on a weak tier — or surfaced
 * nothing at all. A well-corroborated answer from a strong source needs no escalation.
 */
export function decideEscalation(
  ranked: AnswerHypothesis[],
  opts: { enabled?: boolean; minCorroboration?: number } = {},
): EscalationDecision {
  if (opts.enabled === false) return { escalate: false, reason: "escalation disabled" };
  const minCorroboration = opts.minCorroboration ?? ESCALATE_MIN_CORROBORATION;
  const top = ranked[0];
  if (!top) return { escalate: true, reason: "no answer hypothesis surfaced by the fan-out" };
  if (top.bestTier && WEAK_TIERS.has(top.bestTier)) {
    return { escalate: true, hypothesis: top, reason: `top answer rests only on a ${top.bestTier} source` };
  }
  if (top.corroboration < minCorroboration) {
    return {
      escalate: true,
      hypothesis: top,
      reason: `top answer has ${top.corroboration} independent source(s) (< ${minCorroboration})`,
    };
  }
  return { escalate: false, hypothesis: top, reason: "top answer is well-corroborated" };
}
