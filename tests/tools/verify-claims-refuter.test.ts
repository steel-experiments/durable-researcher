// ABOUTME: Tests for the adversarial refuter pass in claim verification.
// ABOUTME: Uses injected verifier + refuter stubs so no real LLM calls are made.

import { describe, it, expect } from "vitest";
import { verifyClaims, type ClaimVerifier } from "../../src/tools/verify-claims.js";
import type { ResearchNote } from "../../src/types.js";

const REPORT = [
  "Alpha fact [1]. Beta fact [2]. Gamma fact [3]. Delta fact [4].",
  "",
  "## Sources",
  "1. [a](https://a.com)",
  "2. [b](https://b.com)",
  "3. [c](https://c.com)",
  "4. [d](https://d.com)",
].join("\n");

const NOTES: ResearchNote[] = [
  { title: "n1", content: "", sourceUrls: ["https://a.com"], confidence: "high", keyExcerpts: ["alpha quote"] },
  { title: "n2", content: "", sourceUrls: ["https://b.com"], confidence: "high", keyExcerpts: ["beta quote"] },
  { title: "n3", content: "", sourceUrls: ["https://c.com"], confidence: "high", keyExcerpts: ["gamma quote"] },
  { title: "n4", content: "", sourceUrls: ["https://d.com"], confidence: "high", keyExcerpts: ["delta quote"] },
];

/** Primary verifier: supports a/b/c, rejects d → 3/4 = 0.75, inside the borderline band. */
const borderlineVerifier: ClaimVerifier = async ({ sourceUrl }) => {
  if (sourceUrl === "https://d.com") return { supported: false, reason: "no" };
  return { supported: true, reason: "ok" };
};

describe("verifyClaims adversarial refuter pass", () => {
  it("flips a borderline-passing claim below threshold when the refuter dissents", async () => {
    // Refuter refutes the [1] claim; b and c survive.
    const refuter: ClaimVerifier = async ({ sourceUrl }) =>
      sourceUrl === "https://a.com"
        ? { supported: false, reason: "quotes do not back the specific fact" }
        : { supported: true, reason: "stands" };

    const result = await verifyClaims({
      report: REPORT,
      notes: NOTES,
      verifier: borderlineVerifier,
      refuter,
    });

    // Started 3/4 supported; refuter removed [1] → 2/4 = 0.5.
    expect(result.summary.supported).toBe(2);
    expect(result.summary.total).toBe(4);
    expect(result.summary.status).toBe("failed");
    const flipped = result.claims.find((c) => c.sourceN === 1);
    expect(flipped?.supported).toBe(false);
    expect(flipped?.reason).toMatch(/refut/i);
  });

  it("does not run the refuter when the result is comfortably above the band", async () => {
    let called = false;
    const allSupported: ClaimVerifier = async () => ({ supported: true, reason: "ok" });
    const refuter: ClaimVerifier = async () => {
      called = true;
      return { supported: false, reason: "should never be consulted" };
    };

    const result = await verifyClaims({
      report: REPORT,
      notes: NOTES,
      verifier: allSupported, // 4/4 = 1.0, above threshold + band
      refuter,
    });

    expect(called).toBe(false);
    expect(result.summary.supported).toBe(4);
  });

  it("leaves the result unchanged when no refuter is provided", async () => {
    const result = await verifyClaims({
      report: REPORT,
      notes: NOTES,
      verifier: borderlineVerifier,
    });
    expect(result.summary.supported).toBe(3);
    expect(result.summary.passRate).toBeCloseTo(0.75, 5);
  });

  it("re-tests each supported claim with multiple independent votes", async () => {
    const calls = new Map<string, number>();
    const refuter: ClaimVerifier = async ({ sourceUrl }) => {
      calls.set(sourceUrl, (calls.get(sourceUrl) ?? 0) + 1);
      return { supported: true, reason: "stands" };
    };
    await verifyClaims({ report: REPORT, notes: NOTES, verifier: borderlineVerifier, refuter });
    // a/b/c were supported in the first pass → each gets the full vote count.
    expect(calls.get("https://a.com")).toBe(3);
    expect(calls.get("https://b.com")).toBe(3);
    expect(calls.get("https://c.com")).toBe(3);
    // d was already unsupported, so it is never re-tested.
    expect(calls.get("https://d.com")).toBeUndefined();
  });

  it("requires a quorum of refuting votes — a lone dissent does not flip", async () => {
    const calls = new Map<string, number>();
    const refuter: ClaimVerifier = async ({ sourceUrl }) => {
      const n = (calls.get(sourceUrl) ?? 0) + 1;
      calls.set(sourceUrl, n);
      // Only the first vote on a.com dissents; 1 of 3 is below the 2-vote quorum.
      if (sourceUrl === "https://a.com" && n === 1) {
        return { supported: false, reason: "lone dissent" };
      }
      return { supported: true, reason: "stands" };
    };
    const result = await verifyClaims({ report: REPORT, notes: NOTES, verifier: borderlineVerifier, refuter });
    expect(result.summary.supported).toBe(3);
    expect(result.claims.find((c) => c.sourceN === 1)?.supported).toBe(true);
  });

  it("flips when a quorum (2 of 3) of skeptics dissents", async () => {
    const calls = new Map<string, number>();
    const refuter: ClaimVerifier = async ({ sourceUrl }) => {
      const n = (calls.get(sourceUrl) ?? 0) + 1;
      calls.set(sourceUrl, n);
      // a.com: votes 1 and 2 dissent, vote 3 supports → 2/3 meets the quorum.
      if (sourceUrl === "https://a.com") return { supported: n > 2, reason: n > 2 ? "stands" : "dissent" };
      return { supported: true, reason: "stands" };
    };
    const result = await verifyClaims({ report: REPORT, notes: NOTES, verifier: borderlineVerifier, refuter });
    expect(result.summary.supported).toBe(2);
    const flipped = result.claims.find((c) => c.sourceN === 1);
    expect(flipped?.supported).toBe(false);
    expect(flipped?.reason).toMatch(/refut/i);
  });

  it("treats refuter errors as abstentions that cannot form a quorum", async () => {
    const calls = new Map<string, number>();
    const refuter: ClaimVerifier = async ({ sourceUrl }) => {
      const n = (calls.get(sourceUrl) ?? 0) + 1;
      calls.set(sourceUrl, n);
      if (sourceUrl === "https://a.com") {
        if (n === 1) return { supported: false, reason: "real dissent" };
        throw new Error("refuter timeout"); // votes 2 and 3 abstain
      }
      return { supported: true, reason: "stands" };
    };
    const result = await verifyClaims({ report: REPORT, notes: NOTES, verifier: borderlineVerifier, refuter });
    // [1] has 1 valid refutation + 2 abstentions → below the 2-vote quorum → kept.
    expect(result.summary.supported).toBe(3);
    expect(result.claims.find((c) => c.sourceN === 1)?.supported).toBe(true);
  });

  it("respects an overridden vote count and quorum", async () => {
    // refuterVotes:1 / refutationsRequired:1 reproduces the old single-refuter pass.
    const refuter: ClaimVerifier = async ({ sourceUrl }) =>
      sourceUrl === "https://a.com"
        ? { supported: false, reason: "no" }
        : { supported: true, reason: "ok" };
    const result = await verifyClaims({
      report: REPORT,
      notes: NOTES,
      verifier: borderlineVerifier,
      refuter,
      refuterVotes: 1,
      refutationsRequired: 1,
    });
    expect(result.summary.supported).toBe(2);
    expect(result.claims.find((c) => c.sourceN === 1)?.supported).toBe(false);
  });
});
