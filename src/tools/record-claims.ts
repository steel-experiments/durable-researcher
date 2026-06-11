// ABOUTME: record_claims tool — records atomic falsifiable claims into the research ledger.
// ABOUTME: Replaces prose-first notes as the agent-facing research memory.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResearchLedger, ResearchNote } from "../types.js";
import { ledgerToNotes, recordClaimsInLedger } from "../ledger.js";

const ClaimEntry = Type.Object({
  text: Type.String({
    description: "Atomic, falsifiable claim. One fact or inference only.",
  }),
  sourceUrl: Type.String({
    description: "Browsed source URL that backs or contradicts this claim.",
  }),
  excerpt: Type.String({
    description: "Short verbatim quote from the source. Must contain the specific fact.",
  }),
  supports: Type.Optional(Type.Boolean({
    description: "true when the excerpt supports the claim, false when it contradicts it.",
  })),
  tier: Type.Optional(
    Type.Union([
      Type.Literal("primary"),
      Type.Literal("secondary"),
      Type.Literal("blog"),
      Type.Literal("forum"),
      Type.Literal("unreliable"),
    ], {
      description: "Provenance quality of this evidence item.",
    }),
  ),
  publishedAt: Type.Optional(Type.String({
    description: "Publication date if visible, ISO-ish string preferred.",
  })),
  requiredClaimIds: Type.Optional(Type.Array(Type.String(), {
    description: "Coverage-map IDs this claim helps answer.",
  })),
});

const RecordClaimsParams = Type.Object({
  claims: Type.Array(ClaimEntry, {
    description:
      "Atomic claims extracted from browsed content. Prefer several focused claims over one broad prose note.",
  }),
});

export type RecordClaimsParamsValue = {
  claims: {
    text: string;
    sourceUrl: string;
    excerpt: string;
    supports?: boolean;
    tier?: "primary" | "secondary" | "blog" | "forum" | "unreliable";
    publishedAt?: string;
    requiredClaimIds?: string[];
  }[];
};

export function createRecordClaimsTool(
  ledger: ResearchLedger,
  notes: ResearchNote[],
): AgentTool<typeof RecordClaimsParams> {
  return {
    name: "record_claims",
    label: "Record Claims",
    description:
      "Record atomic falsifiable claims with verbatim evidence. Use after browsing sources. This is the research ledger; do not write prose notes.",
    parameters: RecordClaimsParams,
    execute: async (_toolCallId, params: RecordClaimsParamsValue) => {
      const rejected = params.claims.filter(isUnsupportedNegativeMetaClaim);
      const accepted = params.claims.filter((claim) => !isUnsupportedNegativeMetaClaim(claim));
      const touched = recordClaimsInLedger(ledger, accepted);
      notes.length = 0;
      notes.push(...ledgerToNotes(ledger));
      const supported = ledger.claims.filter((claim) => claim.status === "supported").length;
      const contested = ledger.claims.filter((claim) => claim.status === "contested").length;
      const refuted = ledger.claims.filter((claim) => claim.status === "refuted").length;
      const rejectionText = rejected.length > 0
        ? ` Rejected ${rejected.length} unsupported negative/meta claim(s): quote a source that itself establishes the absence, or record the scoped source fact instead.`
        : "";
      return {
        content: [{
          type: "text" as const,
          text: `Recorded ${touched.length} claim evidence item(s). Ledger: ${ledger.claims.length} claims (${supported} supported, ${contested} contested, ${refuted} refuted).${rejectionText}`,
        }],
        details: {
          recordedCount: touched.length,
          rejectedCount: rejected.length,
          claimCount: ledger.claims.length,
          evidenceCount: ledger.evidence.length,
          supported,
          contested,
          refuted,
        },
      };
    },
  };
}

const NEGATIVE_META_PATTERNS = [
  /\bno (?:verifiable|primary|secondary|relevant)?\s*source\b/i,
  /\bno (?:source|evidence|record|reference|mention)\b.*\b(?:found|confirm|contains?|documents?|mentions?)\b/i,
  /\bunable to find\b/i,
  /\bcould not find\b/i,
  /\bnot found\b/i,
  /\bno .* (?:was|were) found\b/i,
  /\bdespite extensive (?:searching|research)\b/i,
];

const SCOPED_ABSENCE_EXCERPT_PATTERNS = [
  /\bno (?:results|records|matches|events|races|mention|reference)\b/i,
  /\b0 (?:results|records|matches)\b/i,
  /\bnot found\b/i,
  /\bno .* found\b/i,
  /\bdoes not (?:include|contain|list|mention)\b/i,
];

function isUnsupportedNegativeMetaClaim(claim: RecordClaimsParamsValue["claims"][number]): boolean {
  if (claim.supports === false) return false;
  const text = claim.text.trim();
  if (!NEGATIVE_META_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return !SCOPED_ABSENCE_EXCERPT_PATTERNS.some((pattern) => pattern.test(claim.excerpt));
}
