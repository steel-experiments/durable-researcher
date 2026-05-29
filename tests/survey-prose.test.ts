// ABOUTME: Tests for the constrained survey-prose refinement pass.
// ABOUTME: Uses an injected synthesizer — no real LLM — and locks the anti-collapse guard.

import { describe, it, expect } from "vitest";
import { refineSurveyProse, type ProseSynthesizer } from "../src/survey-prose.js";
import { mergeSurveyParts, assembleSurvey } from "../src/survey-merge.js";

const longConcat =
  "### From Subagent 1\n\n" +
  "Current agent interaction is pointwise and reactive [1]. Users approve individual actions without foresight [2]. ".repeat(6) +
  "\n\n### From Subagent 2\n\n" +
  "Observability is post-hoc rather than live [3]. Frameworks expose interrupts but rarely evaluate them [4]. ".repeat(6);

const parts = {
  title: "S",
  executiveSummary: "exec",
  tables: [{ section: "Systems / Tools Surveyed", markdown: "## Systems / Tools Surveyed\n\n| Name |\n|---|\n| LangGraph |" }],
  prose: [{ section: "Cross-Cutting Findings", body: `## Cross-Cutting Findings\n\n${longConcat}` }],
  entities: ["LangGraph"],
  sources: ["https://a.example", "https://b.example", "https://c.example", "https://d.example"],
  stats: { systems: 1, benchmarks: 0, literature: 0, sources: 4 },
};

describe("refineSurveyProse", () => {
  it("accepts a substantial unified rewrite", async () => {
    const synth: ProseSynthesizer = async () =>
      "Agent interaction today is pointwise and reactive [1], approving actions without foresight [2]. " +
      "Observability remains post-hoc [3], and interrupt features are seldom evaluated [4]. ".repeat(4);
    const overrides = await refineSurveyProse(parts as any, synth);
    expect(overrides["Cross-Cutting Findings"]).toBeTruthy();
    expect(overrides["Cross-Cutting Findings"]).toContain("[1]");
  });

  it("rejects a collapsed meta-acknowledgement and keeps the concat", async () => {
    const synth: ProseSynthesizer = async () =>
      "The section has been unified with all citations preserved.";
    const overrides = await refineSurveyProse(parts as any, synth);
    expect(overrides["Cross-Cutting Findings"]).toBeUndefined();
  });

  it("rejects a too-short refinement (anti-collapse length guard)", async () => {
    const synth: ProseSynthesizer = async () => "Agents are hard to steer [1].";
    const overrides = await refineSurveyProse(parts as any, synth);
    expect(overrides["Cross-Cutting Findings"]).toBeUndefined();
  });

  it("keeps the concat when the synthesizer returns null", async () => {
    const synth: ProseSynthesizer = async () => null;
    const overrides = await refineSurveyProse(parts as any, synth);
    expect(overrides["Cross-Cutting Findings"]).toBeUndefined();
  });

  it("keeps the concat when the synthesizer throws", async () => {
    const synth: ProseSynthesizer = async () => {
      throw new Error("LLM down");
    };
    const overrides = await refineSurveyProse(parts as any, synth);
    expect(overrides["Cross-Cutting Findings"]).toBeUndefined();
  });
});

describe("assembleSurvey with prose override", () => {
  it("splices refined prose under the section heading and drops the concat", () => {
    const merged = assembleSurvey(parts as any, {
      "Cross-Cutting Findings": "Unified finding text [1].",
    });
    expect(merged).toContain("## Cross-Cutting Findings\n\nUnified finding text [1].");
    expect(merged).not.toContain("### From Subagent 1");
  });

  it("falls back to the concat when no override is given for a section", () => {
    const merged = assembleSurvey(parts as any, {});
    expect(merged).toContain("### From Subagent 1");
  });

  it("always renders tables and sources deterministically regardless of override", () => {
    const merged = assembleSurvey(parts as any, { "Cross-Cutting Findings": "x".repeat(300) });
    expect(merged).toContain("## Systems / Tools Surveyed");
    expect(merged).toContain("## Sources");
    expect(merged).toContain("1. https://a.example");
  });
});
