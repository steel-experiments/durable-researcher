// ABOUTME: Tests for the evaluate_progress tool.
// ABOUTME: Verifies mode-aware decision guidance for lookup / extraction / synthesis.

import { describe, it, expect } from "vitest";
import { createEvaluateTool } from "../../src/tools/evaluate.js";
import { createResearchLedger, recordClaimsInLedger } from "../../src/ledger.js";
import type { ResearchLedger, ResearchNote } from "../../src/types.js";

const sampleNotes: ResearchNote[] = [
  {
    title: "Foo",
    content: "Some content about foo",
    sourceUrls: ["https://a.com"],
    confidence: "high",
  },
];

function sampleLedger(): ResearchLedger {
  const ledger = createResearchLedger([
    { id: "rq1", question: "Answer the direct lookup", status: "open", claimIds: [] },
  ]);
  recordClaimsInLedger(ledger, [
    {
      text: "The answer is Foo.",
      sourceUrl: "https://a.com",
      excerpt: "The answer is Foo.",
      tier: "primary",
      requiredClaimIds: ["rq1"],
    },
  ]);
  return ledger;
}

describe("createEvaluateTool", () => {
  it("emits the default decision guidance when mode is synthesis", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]), "synthesis");
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text;
    expect(text).toContain("Decision Guidance");
    expect(text).toContain("synthesize your report");
  });

  it("emits lookup-mode gating when mode is lookup", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]), "lookup", sampleLedger());
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain("lookup");
    expect(text.toLowerCase()).toContain("ledger-first completion");
    expect(text.toLowerCase()).toContain("required claims");
  });

  it("emits extraction-mode gating with explicit field-completion language", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]), "extraction", sampleLedger());
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain("extraction");
    expect(text.toLowerCase()).toContain("ledger-first completion");
    expect(text.toLowerCase()).toContain("open required claims");
  });

  it("defaults to synthesis-mode guidance when mode is omitted", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]));
    const result = await tool.execute("call-1", {});
    expect(result.content[0].text).toContain("synthesize your report");
  });

  it("emits survey-mode gating with breadth thresholds", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]), "survey", sampleLedger());
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain("survey");
    expect(text.toLowerCase()).toContain("claim ledger");
    expect(text.toLowerCase()).toContain("independent corroboration");
  });

  it("drills into contested claims before broadening search", async () => {
    const ledger = createResearchLedger();
    recordClaimsInLedger(ledger, [
      {
        text: "The release date is 2026.",
        sourceUrl: "https://a.com",
        excerpt: "The release date is 2026.",
        tier: "secondary",
      },
      {
        text: "The release date is 2026.",
        sourceUrl: "https://b.com",
        excerpt: "The release date is 2025.",
        supports: false,
        tier: "primary",
      },
    ]);
    const tool = createEvaluateTool([], new Set(), "synthesis", ledger);
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text.toLowerCase();
    expect(text).toContain("next search strategy");
    expect(text).toContain("drill into contested claim");
  });

  it("broadens for open required claims", async () => {
    const ledger = createResearchLedger([
      { id: "rq1", question: "Find the official date", status: "open", claimIds: [] },
    ]);
    const tool = createEvaluateTool([], new Set(), "lookup", ledger);
    const result = await tool.execute("call-1", {});
    expect(result.content[0].text.toLowerCase()).toContain("broaden or redirect search for open required claim rq1");
  });

  it("asks for independent corroboration when claims are thin", async () => {
    const ledger = createResearchLedger();
    recordClaimsInLedger(ledger, [
      {
        text: "The benchmark score is 91%.",
        sourceUrl: "https://a.com",
        excerpt: "The benchmark score is 91%.",
        tier: "primary",
      },
    ]);
    const tool = createEvaluateTool([], new Set(), "survey", ledger);
    const result = await tool.execute("call-1", {});
    expect(result.content[0].text.toLowerCase()).toContain("seek independent corroboration");
  });
});
