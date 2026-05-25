// ABOUTME: Tests for agent orchestration — template loading and result building.
// ABOUTME: Verifies that the system prompt renders correctly and results are structured.

import { describe, it, expect } from "vitest";
import { loadTemplate } from "../src/prompts.js";
import { DEPTH_CONFIG } from "../src/types.js";
import { buildResult } from "../src/agent.js";

describe("loadTemplate", () => {
  it("renders system prompt with topic and depth", async () => {
    const result = await loadTemplate("system", {
      topic: "quantum computing",
      depth: "standard",
      maxSources: 20,
      maxIterations: 3,
    });

    expect(result).toContain("quantum computing");
    expect(result).toContain("standard");
    expect(result).toContain("20");
    expect(result).toContain("plan_research");
    expect(result).toContain("web_search");
    expect(result).toContain("browse_url");
    expect(result).toContain("take_note");
    expect(result).toContain("evaluate_progress");
    expect(result).toContain("prefetch_sources");
  });

  it("renders plan prompt with max queries", async () => {
    const result = await loadTemplate("plan", {
      maxQueries: "5",
      depth: "standard",
    });

    expect(result).toContain("5");
    expect(result).toContain("JSON");
    expect(result).toContain("subQueries");
  });

  it("renders summarize prompt with focus", async () => {
    const result = await loadTemplate("summarize", {
      topic: "AI safety",
      focus: "alignment research",
    });

    expect(result).toContain("alignment research");
    expect(result).toContain("AI safety");
  });

  it("renders summarize prompt without focus", async () => {
    const result = await loadTemplate("summarize", {
      topic: "AI safety",
    });

    expect(result).toContain("AI safety");
    expect(result).toContain("relevant to the research topic");
  });
});

describe("buildResult source titles", () => {
  const notes = [
    {
      title: "n1",
      content: "c1",
      sourceUrls: ["https://known.com/page", "https://unknown.com/page"],
      confidence: "high" as const,
    },
  ];

  it("uses provided urlTitles when available", () => {
    const titles = new Map([["https://known.com/page", "Known Page Title"]]);
    const result = buildResult(notes, "topic", [], undefined, "synthesis", titles);
    const known = result.sources.find((s) => s.url === "https://known.com/page");
    expect(known?.title).toBe("Known Page Title");
  });

  it("falls back to URL when no title is mapped", () => {
    const titles = new Map([["https://known.com/page", "Known Page Title"]]);
    const result = buildResult(notes, "topic", [], undefined, "synthesis", titles);
    const unknown = result.sources.find((s) => s.url === "https://unknown.com/page");
    expect(unknown?.title).toBe("https://unknown.com/page");
  });

  it("defaults to URL titles when no map is provided (backwards compat)", () => {
    const result = buildResult(notes, "topic", [], undefined, "synthesis");
    expect(result.sources[0].title).toBe(result.sources[0].url);
  });
});

describe("DEPTH_CONFIG", () => {
  it("has correct iteration limits", () => {
    expect(DEPTH_CONFIG.quick.maxIterations).toBe(1);
    expect(DEPTH_CONFIG.standard.maxIterations).toBe(3);
    expect(DEPTH_CONFIG.deep.maxIterations).toBe(5);
  });

  it("has correct initial query counts", () => {
    expect(DEPTH_CONFIG.quick.initialQueries).toBe(3);
    expect(DEPTH_CONFIG.standard.initialQueries).toBe(5);
    expect(DEPTH_CONFIG.deep.initialQueries).toBe(8);
  });
});
