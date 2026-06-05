// ABOUTME: Tests for mergeLedgers — pooling per-agent ledgers from a fan-out into one,
// ABOUTME: accumulating independentCorroboration as the cross-agent convergence signal.

import { describe, expect, it } from "vitest";
import {
  createResearchLedger,
  mergeLedgers,
  recordClaimsInLedger,
} from "../src/ledger.js";

describe("mergeLedgers", () => {
  it("returns an empty ledger for no inputs", () => {
    const merged = mergeLedgers([]);
    expect(merged.claims).toEqual([]);
    expect(merged.evidence).toEqual([]);
    expect(merged.evidenceLinks).toEqual([]);
  });

  it("is a faithful copy for a single input ledger", () => {
    const a = createResearchLedger();
    recordClaimsInLedger(a, [
      { text: "Race named Run Forrest Run 5K.", sourceUrl: "https://x.com/a", excerpt: "The Run Forrest Run 5K.", tier: "secondary" },
    ]);
    const merged = mergeLedgers([a]);
    expect(merged.claims).toHaveLength(1);
    expect(merged.claims[0].text).toBe("Race named Run Forrest Run 5K.");
    expect(merged.evidenceLinks).toHaveLength(1);
  });

  it("dedups the same claim across agents and accumulates independent corroboration", () => {
    // Two fan-out workers independently reach the SAME claim from DIFFERENT sources.
    // Merged, that claim should carry independentCorroboration >= 2 — the convergence
    // signal a single reasoner can never produce on its own.
    const agentA = createResearchLedger();
    recordClaimsInLedger(agentA, [
      {
        text: "The race was the Bubba Gump Run Forrest Run 5K.",
        sourceUrl: "https://yelp.com/event",
        excerpt: "Bubba Gump Shrimp Company's Run Forrest Run 5K at California's Great America.",
        tier: "secondary",
      },
    ]);
    const agentB = createResearchLedger();
    recordClaimsInLedger(agentB, [
      {
        text: "The race was the Bubba Gump Run Forrest Run 5K.",
        sourceUrl: "https://bubbagump.com/events",
        excerpt: "Join our annual Run Forrest Run 5K to benefit United Way.",
        tier: "secondary",
      },
    ]);

    const merged = mergeLedgers([agentA, agentB]);
    expect(merged.claims).toHaveLength(1);
    expect(merged.claims[0].independentCorroboration).toBeGreaterThanOrEqual(2);
    expect(merged.evidenceLinks).toHaveLength(2);
    // Both source URLs survive on the merged claim.
    expect(merged.claims[0].sourceUrls.sort()).toEqual(
      ["https://bubbagump.com/events", "https://yelp.com/event"],
    );
  });

  it("keeps distinct claims from different agents separate", () => {
    const a = createResearchLedger();
    recordClaimsInLedger(a, [
      { text: "Located at California's Great America.", sourceUrl: "https://a.com", excerpt: "California's Great America, Santa Clara.", tier: "secondary" },
    ]);
    const b = createResearchLedger();
    recordClaimsInLedger(b, [
      { text: "Benefited United Way of Silicon Valley.", sourceUrl: "https://b.com", excerpt: "Proceeds to United Way of Silicon Valley.", tier: "secondary" },
    ]);
    const merged = mergeLedgers([a, b]);
    expect(merged.claims).toHaveLength(2);
    expect(merged.claims.map((c) => c.text).sort()).toEqual([
      "Benefited United Way of Silicon Valley.",
      "Located at California's Great America.",
    ]);
  });

  it("unions required claims by id and re-links merged claims to them", () => {
    const a = createResearchLedger([
      { id: "answer", question: "What was the race name?", status: "open", claimIds: [] },
    ]);
    recordClaimsInLedger(a, [
      { text: "Run Forrest Run 5K.", sourceUrl: "https://a.com", excerpt: "Run Forrest Run 5K.", tier: "secondary", requiredClaimIds: ["answer"] },
    ]);
    const b = createResearchLedger([
      { id: "venue", question: "Where was it held?", status: "open", claimIds: [] },
    ]);
    recordClaimsInLedger(b, [
      { text: "Held at Great America.", sourceUrl: "https://b.com", excerpt: "Great America, Santa Clara.", tier: "secondary", requiredClaimIds: ["venue"] },
    ]);

    const merged = mergeLedgers([a, b]);
    const ids = merged.requiredClaims.map((r) => r.id).sort();
    expect(ids).toEqual(["answer", "venue"]);
    const answer = merged.requiredClaims.find((r) => r.id === "answer")!;
    expect(answer.status).toBe("answered");
    expect(answer.claimIds.length).toBe(1);
  });
});
