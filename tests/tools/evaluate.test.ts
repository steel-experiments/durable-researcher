// ABOUTME: Tests for the evaluate_progress tool.
// ABOUTME: Verifies mode-aware decision guidance for lookup / extraction / synthesis.

import { describe, it, expect } from "vitest";
import { createEvaluateTool } from "../../src/tools/evaluate.js";
import type { ResearchNote } from "../../src/types.js";

const sampleNotes: ResearchNote[] = [
  {
    title: "Foo",
    content: "Some content about foo",
    sourceUrls: ["https://a.com"],
    confidence: "high",
  },
];

describe("createEvaluateTool", () => {
  it("emits the default decision guidance when mode is synthesis", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]), "synthesis");
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text;
    expect(text).toContain("Decision Guidance");
    expect(text).toContain("synthesize your report");
  });

  it("emits lookup-mode gating when mode is lookup", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]), "lookup");
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain("lookup");
    expect(text.toLowerCase()).toMatch(/direct answer|the answer/);
  });

  it("emits extraction-mode gating with explicit field-completion language", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]), "extraction");
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain("extraction");
    expect(text.toLowerCase()).toMatch(/required.*values|each requested|every required/);
    expect(text.toLowerCase()).toMatch(/missing|not yet extracted/);
  });

  it("defaults to synthesis-mode guidance when mode is omitted", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]));
    const result = await tool.execute("call-1", {});
    expect(result.content[0].text).toContain("synthesize your report");
  });

  it("emits survey-mode gating with breadth thresholds", async () => {
    const tool = createEvaluateTool(sampleNotes, new Set(["https://a.com"]), "survey");
    const result = await tool.execute("call-1", {});
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain("survey");
    expect(text.toLowerCase()).toMatch(/named systems|named benchmarks/);
    expect(text).toMatch(/≥10|10 named/);
    expect(text.toLowerCase()).toContain("breadth");
  });
});
