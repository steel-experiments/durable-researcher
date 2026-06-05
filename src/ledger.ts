// ABOUTME: Claim/evidence ledger helpers for in-loop research state.
// ABOUTME: Keeps live tool execution and durable replay projection deterministic.

import type {
  ClaimEvidenceLink,
  Confidence,
  Evidence,
  EvidenceExcerpt,
  RequiredClaim,
  ResearchClaim,
  ResearchLedger,
  ResearchNote,
  SourceTier,
} from "./types.js";

export type RecordClaimInput = {
  text: string;
  sourceUrl: string;
  excerpt: string;
  supports?: boolean;
  tier?: SourceTier;
  publishedAt?: string;
  requiredClaimIds?: string[];
};

const TIER_RANK: Record<SourceTier, number> = {
  primary: 5,
  secondary: 4,
  blog: 3,
  forum: 2,
  unreliable: 1,
};

export function createResearchLedger(requiredClaims: RequiredClaim[] = []): ResearchLedger {
  return {
    claims: [],
    evidence: [],
    excerpts: [],
    evidenceLinks: [],
    requiredClaims: requiredClaims.map((item) => ({
      ...item,
      claimIds: [...item.claimIds],
    })),
  };
}

export function setRequiredClaims(
  ledger: ResearchLedger,
  requiredClaims: RequiredClaim[] | undefined,
): void {
  if (!requiredClaims?.length) return;
  const existing = new Set(ledger.requiredClaims.map((item) => item.id));
  for (const item of requiredClaims) {
    if (existing.has(item.id)) continue;
    ledger.requiredClaims.push({
      id: item.id,
      question: item.question,
      status: item.status ?? "open",
      claimIds: [...(item.claimIds ?? [])],
    });
  }
  updateCoverage(ledger);
}

export function recordClaimsInLedger(
  ledger: ResearchLedger,
  entries: RecordClaimInput[],
): ResearchClaim[] {
  const touched: ResearchClaim[] = [];
  for (const entry of entries) {
    const text = entry.text.trim();
    const sourceUrl = entry.sourceUrl.trim();
    const excerptText = entry.excerpt.trim();
    if (!text || !sourceUrl || !excerptText) continue;

    const claim = findOrCreateClaim(ledger, text);
    const evidenceId = `evidence-${ledger.evidence.length + 1}`;
    const excerptId = `${evidenceId}-excerpt-1`;
    const tier = entry.tier ?? "secondary";
    const evidence: Evidence = {
      id: evidenceId,
      title: text.slice(0, 80),
      content: excerptText,
      sourceUrls: [sourceUrl],
      excerptIds: [excerptId],
      confidence: "low",
      ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
    };
    const excerpt: EvidenceExcerpt = {
      id: excerptId,
      evidenceId,
      text: excerptText,
      sourceUrl,
    };
    const link: ClaimEvidenceLink = {
      claimId: claim.id,
      evidenceId,
      excerptId,
      sourceUrl,
      supports: entry.supports !== false,
      tier,
      ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
    };

    ledger.evidence.push(evidence);
    ledger.excerpts.push(excerpt);
    ledger.evidenceLinks.push(link);
    attachLinkToClaim(claim, link);

    for (const requiredId of entry.requiredClaimIds ?? []) {
      const required = ledger.requiredClaims.find((item) => item.id === requiredId);
      if (required && !required.claimIds.includes(claim.id)) required.claimIds.push(claim.id);
    }

    recomputeClaim(ledger, claim);
    touched.push(claim);
  }
  updateCoverage(ledger);
  return touched;
}

/**
 * Pool several per-agent ledgers (from a fan-out) into one. The ledger is fully
 * derivable from its evidence links, so we reconstruct each link as a RecordClaimInput
 * and replay them through recordClaimsInLedger — which dedups claims by normalized text
 * and accumulates independentCorroboration. That accumulation is the whole point: when N
 * fan-out workers independently reach the same claim from different sources, the merged
 * claim's corroboration count rises, converting agreement into confidence. A lone
 * reasoner that reaches a claim once (or reaches it and self-rejects) can never produce
 * that signal.
 */
export function mergeLedgers(ledgers: ResearchLedger[]): ResearchLedger {
  const merged = createResearchLedger();
  // Union required claims by id first so replayed entries can re-link to them.
  for (const ledger of ledgers) {
    setRequiredClaims(merged, ledger.requiredClaims);
  }
  const entries: RecordClaimInput[] = [];
  for (const ledger of ledgers) {
    for (const link of ledger.evidenceLinks) {
      const claim = ledger.claims.find((c) => c.id === link.claimId);
      const excerpt = ledger.excerpts.find((e) => e.id === link.excerptId);
      if (!claim || !excerpt) continue;
      const requiredClaimIds = ledger.requiredClaims
        .filter((r) => r.claimIds.includes(link.claimId))
        .map((r) => r.id);
      entries.push({
        text: claim.text,
        sourceUrl: link.sourceUrl,
        excerpt: excerpt.text,
        supports: link.supports,
        tier: link.tier,
        ...(link.publishedAt ? { publishedAt: link.publishedAt } : {}),
        ...(requiredClaimIds.length ? { requiredClaimIds } : {}),
      });
    }
  }
  recordClaimsInLedger(merged, entries);
  return merged;
}

/**
 * Collect the deduped verbatim supporting excerpts backing a set of claims. Shared by the
 * adversarial answer-correctness pass and the carry-forward synthesis builder so both see
 * the same evidence for a hypothesis.
 */
export function supportingExcerptsForClaims(
  ledger: ResearchLedger,
  claimIds: Iterable<string>,
): { text: string; sourceUrl: string }[] {
  const ids = new Set(claimIds);
  const excerptIdToUrl = new Map<string, string>();
  for (const link of ledger.evidenceLinks) {
    if (ids.has(link.claimId) && link.supports) excerptIdToUrl.set(link.excerptId, link.sourceUrl);
  }
  const seen = new Set<string>();
  const out: { text: string; sourceUrl: string }[] = [];
  for (const excerpt of ledger.excerpts) {
    const url = excerptIdToUrl.get(excerpt.id);
    if (!url) continue;
    const key = excerpt.text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: excerpt.text, sourceUrl: url });
  }
  return out;
}

export function ledgerToNotes(ledger: ResearchLedger): ResearchNote[] {
  return ledger.claims.map((claim) => {
    const links = ledger.evidenceLinks.filter((link) => link.claimId === claim.id && link.supports);
    const excerpts = links
      .map((link) => ledger.excerpts.find((excerpt) => excerpt.id === link.excerptId)?.text)
      .filter((text): text is string => !!text);
    const bestTier = bestSourceTier(links.map((link) => link.tier));
    return {
      title: claim.text.slice(0, 80),
      content: claim.text,
      sourceUrls: Array.from(new Set(links.map((link) => link.sourceUrl))),
      confidence: claim.confidence,
      ...(excerpts.length ? { keyExcerpts: excerpts.slice(0, 8) } : {}),
      ...(bestTier ? { sourceTier: bestTier } : {}),
    };
  });
}

function findOrCreateClaim(ledger: ResearchLedger, text: string): ResearchClaim {
  const key = normalizeText(text);
  const existing = ledger.claims.find((claim) => normalizeText(claim.text) === key);
  if (existing) return existing;
  const claim: ResearchClaim = {
    id: `claim-${ledger.claims.length + 1}`,
    text,
    sourceUrls: [],
    evidenceIds: [],
    excerptIds: [],
    confidence: "low",
    status: "open",
    independentCorroboration: 0,
  };
  ledger.claims.push(claim);
  return claim;
}

function attachLinkToClaim(claim: ResearchClaim, link: ClaimEvidenceLink): void {
  if (!claim.sourceUrls.includes(link.sourceUrl)) claim.sourceUrls.push(link.sourceUrl);
  if (!claim.evidenceIds.includes(link.evidenceId)) claim.evidenceIds.push(link.evidenceId);
  if (!claim.excerptIds.includes(link.excerptId)) claim.excerptIds.push(link.excerptId);
}

function recomputeClaim(ledger: ResearchLedger, claim: ResearchClaim): void {
  const links = ledger.evidenceLinks.filter((link) => link.claimId === claim.id);
  const supportLinks = links.filter((link) => link.supports);
  const contradictionLinks = links.filter((link) => !link.supports);
  claim.independentCorroboration = independentSourceCount(ledger, supportLinks);
  claim.status = computeStatus(supportLinks, contradictionLinks);
  claim.confidence = computeConfidence(ledger, supportLinks, contradictionLinks);
  claim.verification = {
    supported: claim.status === "supported" || claim.status === "contested",
    reason: `Ledger status: ${claim.status}; independent corroboration: ${claim.independentCorroboration}`,
  };

  const supportIds = new Set(supportLinks.map((link) => link.evidenceId));
  for (const evidence of ledger.evidence) {
    if (supportIds.has(evidence.id)) evidence.confidence = claim.confidence;
  }
}

function updateCoverage(ledger: ResearchLedger): void {
  for (const required of ledger.requiredClaims) {
    const claims = required.claimIds
      .map((id) => ledger.claims.find((claim) => claim.id === id))
      .filter((claim): claim is ResearchClaim => !!claim);
    if (claims.some((claim) => claim.status === "contested" || claim.status === "refuted")) {
      required.status = "contradicted";
    } else if (claims.some((claim) => claim.status === "supported")) {
      required.status = "answered";
    } else {
      required.status = "open";
    }
  }
}

function computeStatus(
  supportLinks: ClaimEvidenceLink[],
  contradictionLinks: ClaimEvidenceLink[],
): ResearchClaim["status"] {
  if (supportLinks.length === 0 && contradictionLinks.length > 0) return "refuted";
  if (supportLinks.length > 0 && contradictionLinks.length > 0) return "contested";
  if (supportLinks.length > 0) return "supported";
  return "open";
}

function computeConfidence(
  ledger: ResearchLedger,
  supportLinks: ClaimEvidenceLink[],
  contradictionLinks: ClaimEvidenceLink[],
): Confidence {
  if (supportLinks.length === 0 || contradictionLinks.length > 0) return "low";
  const independent = independentSourceCount(ledger, supportLinks);
  const bestTier = bestSourceTier(supportLinks.map((link) => link.tier));
  const newestSupportAgeYears = newestAgeYears(supportLinks);
  const staleSupport = newestSupportAgeYears !== undefined && newestSupportAgeYears > 5;
  if (independent >= 2 && (bestTier === "primary" || bestTier === "secondary")) {
    return staleSupport ? "medium" : "high";
  }
  if (bestTier === "forum" || bestTier === "unreliable") return "low";
  return staleSupport ? "low" : "medium";
}

function independentSourceCount(ledger: ResearchLedger, links: ClaimEvidenceLink[]): number {
  const groups = new Set<string>();
  for (const link of links) {
    const excerpt = ledger.excerpts.find((item) => item.id === link.excerptId)?.text ?? "";
    groups.add(independenceKey(link.sourceUrl, excerpt));
  }
  return groups.size;
}

function bestSourceTier(tiers: SourceTier[]): SourceTier | undefined {
  return tiers.sort((a, b) => TIER_RANK[b] - TIER_RANK[a])[0];
}

function normalizedHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase().replace(/^www\./, "");
  }
}

function independenceKey(url: string, excerpt: string): string {
  const host = normalizedHost(url);
  const normalizedExcerpt = normalizeText(excerpt);
  // Syndicated or copied evidence often appears as identical wording on multiple
  // hosts. Count that as one independent support signal rather than many domains.
  if (normalizedExcerpt.length > 40) return `excerpt:${normalizedExcerpt}`;
  return `host:${host}`;
}

function newestAgeYears(links: ClaimEvidenceLink[]): number | undefined {
  const timestamps = links
    .map((link) => parsePublishedAt(link.publishedAt))
    .filter((value): value is number => value !== undefined);
  if (timestamps.length === 0) return undefined;
  const newest = Math.max(...timestamps);
  return (Date.now() - newest) / (365.25 * 24 * 60 * 60 * 1000);
}

function parsePublishedAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
