// ABOUTME: Tests for claim verification — parsing citations, sources, and the verification orchestrator.
// ABOUTME: Uses an injected verifier stub so no real LLM calls are made.

import { describe, it, expect } from "vitest";
import {
  parseSourcesSection,
  parseCitations,
  excerptsForSource,
  verifyClaims,
  computeVerificationSummary,
  buildRewriteSteering,
  shouldTriggerRewrite,
  VERIFY_PASS_THRESHOLD,
  type ClaimVerifier,
} from "../../src/tools/verify-claims.js";
import type { ResearchNote } from "../../src/types.js";

describe("parseSourcesSection", () => {
  it("returns empty map when no Sources heading is present", () => {
    const report = "# Report\n\nSome content without sources.";
    expect(parseSourcesSection(report).size).toBe(0);
  });

  it("parses ## Sources with markdown link format", () => {
    const report = [
      "# Report",
      "Body text [1] here.",
      "",
      "## Sources",
      "1. Acme — *Title One* — [acme.com](https://acme.com/page-one)",
      "2. Beta — *Title Two* — [beta.io](https://beta.io/x)",
    ].join("\n");
    const map = parseSourcesSection(report);
    expect(map.get(1)).toBe("https://acme.com/page-one");
    expect(map.get(2)).toBe("https://beta.io/x");
  });

  it("parses ### Sources heading too", () => {
    const report = "### Sources\n1. T — [a](https://a.com/p)\n";
    expect(parseSourcesSection(report).get(1)).toBe("https://a.com/p");
  });

  it("handles bare URLs without markdown link syntax", () => {
    const report = "## Sources\n1. https://plain.example.com/page\n";
    expect(parseSourcesSection(report).get(1)).toBe(
      "https://plain.example.com/page",
    );
  });

  it("stops at the next top-level heading", () => {
    const report = [
      "## Sources",
      "1. T — [a](https://a.com/p)",
      "",
      "## Uncertainty",
      "2. Not a source — [b](https://b.com/p)",
    ].join("\n");
    const map = parseSourcesSection(report);
    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(false);
  });
});

describe("parseCitations", () => {
  it("returns empty for no citations", () => {
    expect(parseCitations("Plain text with no markers.")).toEqual([]);
  });

  it("captures a [n] citation with the surrounding sentence", () => {
    const report = "Quantum chips dropped to 0.143% error rate [1]. Other content.";
    const claims = parseCitations(report);
    expect(claims).toHaveLength(1);
    expect(claims[0].sourceN).toBe(1);
    expect(claims[0].text).toContain("0.143%");
  });

  it("expands multi-source citations [1, 2] into separate claims", () => {
    const report = "Multiple labs report the same trend [1, 2].";
    const claims = parseCitations(report);
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.sourceN).sort()).toEqual([1, 2]);
    expect(claims[0].text).toBe(claims[1].text);
  });

  it("ignores citations inside the Sources section", () => {
    const report = [
      "Body claim [1].",
      "## Sources",
      "1. Title — [a](https://a.com/p) (mentions [2] in title)",
    ].join("\n");
    const claims = parseCitations(report);
    expect(claims).toHaveLength(1);
    expect(claims[0].sourceN).toBe(1);
  });

  it("handles citations on paragraph boundaries", () => {
    const report = "First paragraph claim [1].\n\nSecond paragraph claim [2].";
    const claims = parseCitations(report);
    expect(claims.map((c) => c.sourceN)).toEqual([1, 2]);
    expect(claims[0].text).toContain("First");
    expect(claims[1].text).toContain("Second");
  });
});

describe("excerptsForSource", () => {
  const notes: ResearchNote[] = [
    {
      title: "A",
      content: "Content A",
      sourceUrls: ["https://acme.com/p1", "https://acme.com/p2"],
      confidence: "high",
      keyExcerpts: ["A-quote-1", "A-quote-2"],
    },
    {
      title: "B",
      content: "Content B",
      sourceUrls: ["https://beta.io/x"],
      confidence: "medium",
      keyExcerpts: ["B-quote-1"],
    },
    {
      title: "C",
      content: "Content C",
      sourceUrls: ["https://acme.com/p1"],
      confidence: "high",
      keyExcerpts: ["A-quote-1", "C-quote-1"],
    },
  ];

  it("returns deduped excerpts from notes whose sourceUrls include the URL", () => {
    const got = excerptsForSource(notes, "https://acme.com/p1");
    expect(got).toContain("A-quote-1");
    expect(got).toContain("A-quote-2");
    expect(got).toContain("C-quote-1");
    expect(got.filter((e) => e === "A-quote-1")).toHaveLength(1);
  });

  it("returns empty array for an unknown URL", () => {
    expect(excerptsForSource(notes, "https://unknown.com/page")).toEqual([]);
  });

  it("returns empty array when notes have no excerpts", () => {
    const noExcerpts: ResearchNote[] = [
      { title: "X", content: "c", sourceUrls: ["https://a.com"], confidence: "high" },
    ];
    expect(excerptsForSource(noExcerpts, "https://a.com")).toEqual([]);
  });
});

describe("computeVerificationSummary", () => {
  it("returns zeros for no claims", () => {
    const s = computeVerificationSummary([]);
    expect(s).toEqual({ total: 0, supported: 0, unsupported: 0, passRate: 1 });
  });

  it("computes pass rate over the verified set", () => {
    const s = computeVerificationSummary([
      { claim: "a", sourceN: 1, sourceUrl: "u", supported: true, reason: "" },
      { claim: "b", sourceN: 2, sourceUrl: "u", supported: false, reason: "" },
      { claim: "c", sourceN: 3, sourceUrl: "u", supported: true, reason: "" },
    ]);
    expect(s.total).toBe(3);
    expect(s.supported).toBe(2);
    expect(s.unsupported).toBe(1);
    expect(s.passRate).toBeCloseTo(2 / 3);
  });
});

describe("verifyClaims (with stubbed verifier)", () => {
  const notes: ResearchNote[] = [
    {
      title: "Quantum",
      content: "Quantum error rates dropped",
      sourceUrls: ["https://acme.com/p1"],
      confidence: "high",
      keyExcerpts: ["Logical error rate dropped to 0.143% in Willow chip"],
    },
    {
      title: "Other",
      content: "Other context",
      sourceUrls: ["https://beta.io/x"],
      confidence: "medium",
      keyExcerpts: ["Cosmic rays are unrelated to error correction"],
    },
  ];

  const report = [
    "Quantum chips dropped to 0.143% error rate [1].",
    "Cosmic rays cause most errors [2].",
    "",
    "## Sources",
    "1. Acme — [acme.com](https://acme.com/p1)",
    "2. Beta — [beta.io](https://beta.io/x)",
  ].join("\n");

  it("verifies each claim against its cited source's excerpts", async () => {
    const calls: { claim: string; excerptCount: number }[] = [];
    const verifier: ClaimVerifier = async ({ claim, excerpts }) => {
      calls.push({ claim, excerptCount: excerpts.length });
      const supported = excerpts.some((e) =>
        claim.toLowerCase().includes("0.143%") &&
        e.toLowerCase().includes("0.143%"),
      );
      return { supported, reason: supported ? "matches" : "no match" };
    };

    const result = await verifyClaims({ report, notes, verifier });
    expect(result.claims).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(result.summary.supported).toBe(1);
    expect(result.summary.unsupported).toBe(1);
    expect(result.summary.passRate).toBeCloseTo(0.5);
  });

  it("marks claims unsupported when the cited source N has no URL mapping", async () => {
    const reportBadCite =
      "Mystery fact [99].\n\n## Sources\n1. — [a](https://a.com/p)\n";
    const verifier: ClaimVerifier = async () => ({
      supported: true,
      reason: "should not be called",
    });
    const result = await verifyClaims({ report: reportBadCite, notes, verifier });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].supported).toBe(false);
    expect(result.claims[0].reason).toMatch(/source.*not.*found/i);
  });

  it("marks claims unsupported when cited source has no excerpts to ground against", async () => {
    const notesNoExcerpts: ResearchNote[] = [
      {
        title: "Bare",
        content: "no excerpts",
        sourceUrls: ["https://acme.com/p1"],
        confidence: "high",
      },
    ];
    const verifier: ClaimVerifier = async () => ({
      supported: true,
      reason: "should not be called",
    });
    const result = await verifyClaims({
      report: "Bare claim [1].\n\n## Sources\n1. — [a](https://acme.com/p1)\n",
      notes: notesNoExcerpts,
      verifier,
    });
    expect(result.claims[0].supported).toBe(false);
    expect(result.claims[0].reason).toMatch(/no excerpts/i);
  });

  it("never triggers rewrite when there are no citations to verify", () => {
    const summary = { total: 0, supported: 0, unsupported: 0, passRate: 1 };
    expect(shouldTriggerRewrite({ claims: [], summary })).toBe(false);
  });

  it("triggers rewrite when pass rate is below threshold", () => {
    const summary = {
      total: 4,
      supported: 1,
      unsupported: 3,
      passRate: 0.25,
    };
    expect(shouldTriggerRewrite({ claims: [], summary })).toBe(true);
  });

  it("does not trigger rewrite when pass rate is at or above threshold", () => {
    const at = {
      total: 10,
      supported: 7,
      unsupported: 3,
      passRate: 0.7,
    };
    expect(shouldTriggerRewrite({ claims: [], summary: at })).toBe(false);
    expect(VERIFY_PASS_THRESHOLD).toBe(0.7);
  });

  it("buildRewriteSteering lists failed claims and includes the threshold", () => {
    const text = buildRewriteSteering({
      claims: [
        { claim: "fact one", sourceN: 1, sourceUrl: "https://a.com", supported: false, reason: "not in source" },
        { claim: "fact two", sourceN: 2, sourceUrl: "https://b.com", supported: true, reason: "matches" },
      ],
      summary: { total: 2, supported: 1, unsupported: 1, passRate: 0.5 },
    });
    expect(text).toContain("Citation verification");
    expect(text).toContain("fact one");
    expect(text).not.toMatch(/fact two/);
  });

  it("returns empty result when no citations are found", async () => {
    const verifier: ClaimVerifier = async () => ({
      supported: true,
      reason: "n/a",
    });
    const result = await verifyClaims({
      report: "Plain prose with no citations.",
      notes,
      verifier,
    });
    expect(result.claims).toHaveLength(0);
    expect(result.summary.passRate).toBe(1);
  });

  it("falls back to urlExcerpts when notes have no excerpts for the cited URL", async () => {
    // This is the citation-attribution failure mode: the model browsed URL A, wrote a
    // note citing URL B (same content found at both places), then cited URL A in the
    // report. With urlExcerpts populated from the browse, the verifier should still be
    // able to ground the claim instead of failing with "No excerpts recorded".
    const notesCitingB: ResearchNote[] = [
      {
        title: "Original Paper",
        content: "LoRA paper",
        sourceUrls: ["https://b.com/paper"],
        confidence: "high",
        keyExcerpts: ["B-side quote does not mention 0.143%"],
      },
    ];

    const reportCitingA = [
      "Quantum chips dropped to 0.143% error rate [1].",
      "",
      "## Sources",
      "1. arXiv — [a.com](https://a.com/paper)",
    ].join("\n");

    const urlExcerpts = new Map<string, string[]>([
      ["https://a.com/paper", ["Logical error rate dropped to 0.143% in Willow chip."]],
    ]);

    const calls: string[] = [];
    const verifier: ClaimVerifier = async ({ excerpts }) => {
      calls.push(excerpts.join("|"));
      const supported = excerpts.some((e) => e.includes("0.143%"));
      return { supported, reason: supported ? "found" : "missing" };
    };

    const result = await verifyClaims({
      report: reportCitingA,
      notes: notesCitingB,
      verifier,
      urlExcerpts,
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].supported).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("prefers note excerpts over urlExcerpts when both are available", async () => {
    // When the note itself lists the URL, those excerpts win — they're explicit
    // attribution by the model rather than implicit fallback from browse.
    const notesWithA: ResearchNote[] = [
      {
        title: "A",
        content: "from A",
        sourceUrls: ["https://a.com/p"],
        confidence: "high",
        keyExcerpts: ["NOTE_EXCERPT_A"],
      },
    ];
    const urlExcerpts = new Map<string, string[]>([
      ["https://a.com/p", ["URL_EXCERPT_A"]],
    ]);

    const seen: string[][] = [];
    const verifier: ClaimVerifier = async ({ excerpts }) => {
      seen.push(excerpts);
      return { supported: true, reason: "ok" };
    };

    await verifyClaims({
      report: "Claim [1].\n\n## Sources\n1. — [a](https://a.com/p)\n",
      notes: notesWithA,
      verifier,
      urlExcerpts,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("NOTE_EXCERPT_A");
    expect(seen[0]).not.toContain("URL_EXCERPT_A");
  });

  it("still marks claims unsupported when neither notes nor urlExcerpts have anything", async () => {
    const notesEmpty: ResearchNote[] = [];
    const urlExcerpts = new Map<string, string[]>();
    const verifier: ClaimVerifier = async () => ({ supported: true, reason: "n/a" });

    const result = await verifyClaims({
      report: "Claim [1].\n\n## Sources\n1. — [a](https://a.com/p)\n",
      notes: notesEmpty,
      verifier,
      urlExcerpts,
    });

    expect(result.claims[0].supported).toBe(false);
    expect(result.claims[0].reason).toMatch(/no excerpts/i);
  });
});
