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
});
