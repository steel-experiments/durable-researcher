// ABOUTME: Tests for deterministic survey-report merging.
// ABOUTME: Locks table union, fuzzy dedup, and cross-report citation remapping.

import { describe, it, expect } from "vitest";
import { mergeSurveyReports, normalizeKey, type SurveyReportInput } from "../src/survey-merge.js";

const reportA: SurveyReportInput = {
  label: "Subagent 1",
  report: [
    "# Agent Survey",
    "",
    "## Executive Summary",
    "Short summary A.",
    "",
    "## Systems / Tools Surveyed",
    "",
    "| Name | Year | Org | Key Capability | Source |",
    "|------|------|-----|----------------|--------|",
    "| LangGraph | 2024 | LangChain | interrupt() gates | [1] |",
    "| Cradle | 2024 | BAAI | screenshot control | [2] |",
    "",
    "## Sources",
    "1. https://langchain-ai.github.io/langgraph/",
    "2. https://github.com/BAAI-Agents/Cradle",
  ].join("\n"),
};

const reportB: SurveyReportInput = {
  label: "Subagent 2",
  report: [
    "# Agent Survey",
    "",
    "## Executive Summary",
    "A considerably longer executive summary that should win the length tiebreak for the merged report.",
    "",
    "## Systems / Tools Surveyed",
    "",
    "| Name | Year | Org | Key Capability | Source |",
    "|------|------|-----|----------------|--------|",
    "| LangGraph | 2024 | LangChain | Dynamic interrupts with checkpointing and approval workflows | [3] |",
    "| Devin | 2024 | Cognition | autonomous coding | [1] |",
    "",
    "## Sources",
    "[1] https://cognition.ai/devin",
    "[3] https://langchain-ai.github.io/langgraph/",
  ].join("\n"),
};

describe("normalizeKey", () => {
  it("strips version, parentheticals, markdown, punctuation", () => {
    expect(normalizeKey("AutoGen v0.4")).toBe("autogen");
    expect(normalizeKey("CrewAI (João Moura)")).toBe("crewai");
    expect(normalizeKey("`interrupt()`")).toBe("interrupt");
  });
});

describe("mergeSurveyReports", () => {
  const result = mergeSurveyReports([reportA, reportB]);

  it("unions distinct systems across reports", () => {
    // LangGraph (shared) + Cradle + Devin = 3 distinct
    expect(result.stats.systems).toBe(3);
  });

  it("builds one global Sources list deduped by URL", () => {
    // langgraph (A1 + B3 same URL), cradle, devin = 3 unique URLs
    expect(result.stats.sources).toBe(3);
    const sourceLines = result.markdown.split("## Sources")[1].trim().split("\n");
    expect(sourceLines).toHaveLength(3);
  });

  it("prefers the longer cell when merging a shared row", () => {
    expect(result.markdown).toContain("Dynamic interrupts with checkpointing");
    expect(result.markdown).not.toContain("interrupt() gates |");
  });

  it("remaps citations to global numbers with no dangling markers", () => {
    // No empty [] markers from failed remap.
    expect(result.markdown).not.toContain("[]");
    // Every [n] in the body resolves to a source line number that exists.
    const sourceCount = result.stats.sources;
    const refs = [...result.markdown.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    for (const ref of refs) {
      expect(ref).toBeGreaterThanOrEqual(1);
      expect(ref).toBeLessThanOrEqual(sourceCount);
    }
  });

  it("remaps the SAME url cited under different local numbers to one global number", () => {
    // LangGraph is [1] in A and [3] in B but the same URL → one global number, used once in the row.
    const langgraphRow = result.markdown
      .split("\n")
      .find((l) => l.startsWith("| LangGraph") || l.startsWith("| langgraph"));
    expect(langgraphRow).toBeTruthy();
    const refs = [...(langgraphRow ?? "").matchAll(/\[(\d+)\]/g)];
    expect(refs).toHaveLength(1);
  });

  it("picks the longest executive summary", () => {
    expect(result.markdown).toContain("considerably longer executive summary");
  });

  it("handles both '1.' and '[1]' source line formats", () => {
    // reportA uses "1." form, reportB uses "[1]" form; both must contribute URLs.
    expect(result.markdown).toContain("https://github.com/BAAI-Agents/Cradle");
    expect(result.markdown).toContain("https://cognition.ai/devin");
  });

  it("fuzzy-dedups token-subset entity names", () => {
    const withVariants = mergeSurveyReports([
      {
        label: "A",
        report: [
          "# S",
          "## Systems / Tools Surveyed",
          "| Name | Source |",
          "|------|--------|",
          "| A2A Protocol | [1] |",
          "## Sources",
          "1. https://a2a.example",
        ].join("\n"),
      },
      {
        label: "B",
        report: [
          "# S",
          "## Systems / Tools Surveyed",
          "| Name | Source |",
          "|------|--------|",
          "| Google A2A Protocol | [1] |",
          "## Sources",
          "1. https://a2a.example",
        ].join("\n"),
      },
    ]);
    expect(withVariants.stats.systems).toBe(1);
  });
});
