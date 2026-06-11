// ABOUTME: Tests for the independent second synthesis audit helpers.
// ABOUTME: Covers JSON parsing and rewrite steering without making LLM calls.

import { describe, expect, it } from "vitest";
import {
  buildLedgerDigest,
  buildSynthesisAuditSteering,
  parseSynthesisAudit,
} from "../src/synthesis-audit.js";
import { createResearchLedger, recordClaimsInLedger } from "../src/ledger.js";

describe("parseSynthesisAudit", () => {
  it("parses structured audit JSON and requires issues for rewrite", () => {
    const result = parseSynthesisAudit(`
      {"independentSynthesis":"Use cautious wording.","issues":[{"type":"overclaim","claim":"X is certain","reason":"Ledger confidence is low"}],"needsRewrite":true}
    `);

    expect(result.needsRewrite).toBe(true);
    expect(result.issues[0]).toMatchObject({
      type: "overclaim",
      claim: "X is certain",
    });
  });

  it("treats malformed audit output as non-blocking", () => {
    expect(parseSynthesisAudit("not json").needsRewrite).toBe(false);
  });
});

describe("buildSynthesisAuditSteering", () => {
  it("asks the agent to reconcile independent synthesis issues", () => {
    const text = buildSynthesisAuditSteering({
      independentSynthesis: "The ledger supports a narrower conclusion.",
      issues: [{ type: "missing", claim: "Claim A", reason: "Central supported claim omitted" }],
      needsRewrite: true,
    });

    expect(text).toContain("[SECOND SYNTHESIS AUDIT]");
    expect(text).toContain("Claim A");
    expect(text).toContain("Do NOT call any tools");
    expect(text).toContain("Output only the corrected report itself");
  });
});

describe("buildLedgerDigest", () => {
  it("includes required claims, claim confidence, support polarity, tier, and dates", () => {
    const ledger = createResearchLedger([
      { id: "rq1", question: "Answer the question", status: "open", claimIds: [] },
    ]);
    recordClaimsInLedger(ledger, [
      {
        text: "The answer is 42.",
        sourceUrl: "https://example.com",
        excerpt: "The answer is 42.",
        tier: "primary",
        publishedAt: "2026-01-01",
        requiredClaimIds: ["rq1"],
      },
    ]);

    const digest = buildLedgerDigest(ledger);
    expect(digest).toContain("rq1 [answered]");
    expect(digest).toContain("claim-1 [supported");
    expect(digest).toContain("supports; primary; 2026-01-01");
  });
});
