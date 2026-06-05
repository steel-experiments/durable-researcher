// ABOUTME: Tests for the external-contradiction verification pass and its strong-claim gate.
// ABOUTME: Uses injected verifier + contradiction-checker stubs so no real search/LLM runs.

import { describe, it, expect } from "vitest";
import {
  verifyClaims,
  isStrongClaim,
  type ClaimVerifier,
  type ContradictionChecker,
} from "../../src/tools/verify-claims.js";
import type { ResearchNote } from "../../src/types.js";

// Four claims: [1] and [3] are strong (carry a number); [2] and [4] are weak.
const REPORT = [
  "Model X scored 92% on the benchmark [1]. The tool is widely adopted [2]. Version 3.0 shipped in 2024 [3]. The system works well [4].",
  "",
  "## Sources",
  "1. [a](https://a.com)",
  "2. [b](https://b.com)",
  "3. [c](https://c.com)",
  "4. [d](https://d.com)",
].join("\n");

const NOTES: ResearchNote[] = [
  { title: "n1", content: "", sourceUrls: ["https://a.com"], confidence: "high", keyExcerpts: ["a quote"] },
  { title: "n2", content: "", sourceUrls: ["https://b.com"], confidence: "high", keyExcerpts: ["b quote"] },
  { title: "n3", content: "", sourceUrls: ["https://c.com"], confidence: "high", keyExcerpts: ["c quote"] },
  { title: "n4", content: "", sourceUrls: ["https://d.com"], confidence: "high", keyExcerpts: ["d quote"] },
];

/** Supports a/b/c, rejects d → 3/4 = 0.75, inside the borderline band. */
const borderlineVerifier: ClaimVerifier = async ({ sourceUrl }) =>
  sourceUrl === "https://d.com" ? { supported: false, reason: "no" } : { supported: true, reason: "ok" };

describe("isStrongClaim", () => {
  it("treats claims carrying a number/percentage/year/version as strong", () => {
    expect(isStrongClaim("Model X scored 92% on the benchmark")).toBe(true);
    expect(isStrongClaim("Version 3.0 shipped in 2024")).toBe(true);
  });

  it("treats multi-word proper-noun claims as strong", () => {
    expect(isStrongClaim("Claude Opus leads the leaderboard")).toBe(true);
  });

  it("treats vague qualitative claims as weak", () => {
    expect(isStrongClaim("The tool is widely adopted")).toBe(false);
    expect(isStrongClaim("The system works well")).toBe(false);
  });
});

describe("verifyClaims external-contradiction pass", () => {
  it("flips a strong, supported claim when external evidence contradicts it", async () => {
    const checker: ContradictionChecker = async ({ sourceUrl }) =>
      sourceUrl === "https://a.com"
        ? { contradicted: true, evidence: "a newer source reports 71%", counterSource: "https://truth.com" }
        : { contradicted: false, evidence: "no dispute found" };

    const result = await verifyClaims({
      report: REPORT,
      notes: NOTES,
      verifier: borderlineVerifier,
      contradictionChecker: checker,
    });

    expect(result.summary.supported).toBe(2); // [1] flipped, [2]+[3] stand, [4] already failed
    const flipped = result.claims.find((c) => c.sourceNs.includes(1));
    expect(flipped?.supported).toBe(false);
    expect(flipped?.reason).toMatch(/contradict/i);
    expect(flipped?.reason).toContain("truth.com");
  });

  it("only checks strong, supported claims — never weak or already-failed ones", async () => {
    const seen: string[] = [];
    const checker: ContradictionChecker = async ({ sourceUrl }) => {
      seen.push(sourceUrl);
      return { contradicted: false, evidence: "ok" };
    };

    await verifyClaims({
      report: REPORT,
      notes: NOTES,
      verifier: borderlineVerifier,
      contradictionChecker: checker,
    });

    // Strong + supported: [1] (a.com) and [3] (c.com). Weak [2] and failed [4] are skipped.
    expect(seen.sort()).toEqual(["https://a.com", "https://c.com"]);
  });

  it("abstains (keeps the claim) when the checker errors", async () => {
    const checker: ContradictionChecker = async () => {
      throw new Error("search timeout");
    };

    const result = await verifyClaims({
      report: REPORT,
      notes: NOTES,
      verifier: borderlineVerifier,
      contradictionChecker: checker,
    });

    // Checker errored on every strong claim → no flips, first-pass 3/4 stands.
    expect(result.summary.supported).toBe(3);
    expect(result.claims.find((c) => c.sourceNs.includes(1))?.supported).toBe(true);
  });

  it("does not run when the result is comfortably above the band", async () => {
    let called = false;
    const allSupported: ClaimVerifier = async () => ({ supported: true, reason: "ok" });
    const checker: ContradictionChecker = async () => {
      called = true;
      return { contradicted: true, evidence: "should never be consulted" };
    };

    await verifyClaims({
      report: REPORT,
      notes: NOTES,
      verifier: allSupported, // 4/4 = 1.0, above threshold + band
      contradictionChecker: checker,
    });

    expect(called).toBe(false);
  });
});
