// ABOUTME: Tests for agent orchestration — template loading and result building.
// ABOUTME: Verifies that the system prompt renders correctly and results are structured.

import { describe, it, expect, afterEach } from "vitest";
import { loadTemplate } from "../src/prompts.js";
import { DEPTH_CONFIG } from "../src/types.js";
import { buildResult, resolveCacheKey } from "../src/agent.js";

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

  it("renders the survey-mode system prompt with enumeration tables and gap/chase guidance", async () => {
    const result = await loadTemplate("system", {
      topic: "state of agent steering",
      depth: "deep",
      mode: "survey",
      maxSources: 80,
      maxIterations: 10,
    });

    expect(result).toContain("Survey-mode template");
    expect(result).toContain("Systems / Tools Surveyed");
    expect(result).toContain("Benchmarks / Datasets");
    expect(result).toContain("gap_analysis");
    expect(result).toContain("chase_references");
    expect(result).toContain("find_entity");
  });

  it("renders the synthesis-mode system prompt without survey tables", async () => {
    const result = await loadTemplate("system", {
      topic: "x",
      depth: "standard",
      mode: "synthesis",
      maxSources: 50,
      maxIterations: 5,
    });

    expect(result).toContain("Synthesis-mode template");
    expect(result).not.toContain("Systems / Tools Surveyed");
    // synthesis still gets optional gap analysis guidance
    expect(result).toContain("gap_analysis");
  });

  it("requires citing only browsed sources in every mode's prompt", async () => {
    for (const mode of ["synthesis", "survey", "extraction", "lookup"] as const) {
      const result = await loadTemplate("system", {
        topic: "t",
        depth: "standard",
        mode,
        maxSources: 50,
        maxIterations: 5,
      });
      expect(result).toContain("Only cite sources you actually browsed");
    }
  });

  it("renders the survey-mode plan prompt with the enumeration lens block", async () => {
    const result = await loadTemplate("plan", {
      maxQueries: "12",
      depth: "deep",
      mode: "survey",
    });

    expect(result).toContain("Survey mode");
    expect(result.toLowerCase()).toContain("enumeration");
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

  it("prefers a submitted report tool payload over trailing assistant text", () => {
    const submitted = "# Submitted\n\nFull report body [1].\n\n## Sources\n1. https://known.com/page";
    const result = buildResult(
      notes,
      "topic",
      [
        {
          role: "assistant" as const,
          content: [
            {
              type: "toolCall" as const,
              id: "call-1",
              name: "submit_report",
              arguments: { report: submitted },
            },
          ],
          timestamp: Date.now(),
        },
        {
          role: "toolResult" as const,
          toolCallId: "call-1",
          toolName: "submit_report",
          content: [{ type: "text" as const, text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Done." }],
          timestamp: Date.now(),
        },
      ],
      undefined,
      "synthesis",
    );

    expect(result.report).toBe(submitted);
  });

  it("builds an extraction evidence table from notes", () => {
    const result = buildResult(
      [
        {
          title: "Revenue",
          content: "Revenue was $10m.",
          sourceUrls: ["https://known.com/page"],
          confidence: "medium" as const,
          keyExcerpts: ["Revenue: $10m"],
        },
      ],
      "topic",
      [],
      undefined,
      "extraction",
      new Map([["https://known.com/page", "Known Page Title"]]),
    );

    expect(result.explanation?.evidence).toHaveLength(1);
    expect(result.explanation?.excerpts[0]?.text).toBe("Revenue: $10m");
    expect(result.explanation?.sources[0]?.title).toBe("Known Page Title");
    expect(result.explanation?.recommendedViews[0]).toMatchObject({
      kind: "extraction_evidence_table",
      rows: [
        expect.objectContaining({
          label: "Revenue",
          confidence: "medium",
          missingFields: [],
        }),
      ],
    });
  });

  it("uses a report evidence table for extraction artifacts when present", () => {
    const report = [
      "# ACME Extracts",
      "",
      "## Evidence Table",
      "",
      "| # | Metric | Value | Period | Source | Confidence |",
      "|---|--------|-------|--------|--------|------------|",
      "| 1 | Revenue | $10m | FY2025 | [1] | High |",
      "| 2 | Guidance | Not provided | — | [1] | Medium |",
      "",
      "## Analysis",
      "",
      "Revenue increased while guidance was not provided [1].",
      "",
      "## Sources",
      "",
      "1. ACME Annual Report, https://known.com/page",
    ].join("\n");
    const result = buildResult(
      [
        {
          title: "Revenue",
          content: "Revenue was $10m.",
          sourceUrls: ["https://known.com/page"],
          confidence: "high" as const,
          keyExcerpts: ["Revenue: $10m"],
        },
      ],
      "topic",
      [
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: report }],
          timestamp: Date.now(),
        },
      ],
      undefined,
      "extraction",
      new Map([["https://known.com/page", "Known Page Title"]]),
    );

    const artifact = result.explanation?.recommendedViews[0];
    expect(result.explanation?.answer).toBe("Revenue increased while guidance was not provided [1].");
    expect(artifact).toMatchObject({
      kind: "extraction_evidence_table",
      rows: [
        expect.objectContaining({
          label: "Revenue",
          confidence: "high",
          fields: [
            { label: "Value", value: "$10m" },
            { label: "Period", value: "FY2025" },
          ],
          missingFields: [],
        }),
        expect.objectContaining({
          label: "Guidance",
          confidence: "medium",
          fields: [
            { label: "Value", value: "Not provided" },
            { label: "Period", value: "—" },
          ],
          missingFields: ["high-confidence support"],
        }),
      ],
    });
  });
});

describe("resolveCacheKey", () => {
  const original = process.env.BENCH_CACHE_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BENCH_CACHE_KEY;
    } else {
      process.env.BENCH_CACHE_KEY = original;
    }
  });

  it("returns ctx.taskID when BENCH_CACHE_KEY is unset", () => {
    delete process.env.BENCH_CACHE_KEY;
    expect(resolveCacheKey("ctx-task-123")).toBe("ctx-task-123");
  });

  it("returns BENCH_CACHE_KEY when it is set, overriding ctx.taskID", () => {
    process.env.BENCH_CACHE_KEY = "draco:abc-def";
    expect(resolveCacheKey("ctx-task-123")).toBe("draco:abc-def");
  });

  it("ignores an empty BENCH_CACHE_KEY", () => {
    process.env.BENCH_CACHE_KEY = "";
    expect(resolveCacheKey("ctx-task-123")).toBe("ctx-task-123");
  });
});

describe("DEPTH_CONFIG", () => {
  it("has correct iteration limits", () => {
    expect(DEPTH_CONFIG.quick.maxIterations).toBe(2);
    expect(DEPTH_CONFIG.standard.maxIterations).toBe(5);
    expect(DEPTH_CONFIG.deep.maxIterations).toBe(10);
  });

  it("has correct initial query counts", () => {
    expect(DEPTH_CONFIG.quick.initialQueries).toBe(4);
    expect(DEPTH_CONFIG.standard.initialQueries).toBe(7);
    expect(DEPTH_CONFIG.deep.initialQueries).toBe(12);
  });

  it("has source ceilings that scale with depth", () => {
    expect(DEPTH_CONFIG.quick.maxSources).toBe(20);
    expect(DEPTH_CONFIG.standard.maxSources).toBe(50);
    expect(DEPTH_CONFIG.deep.maxSources).toBe(80);
  });

  it("budgets gap-fill passes that scale with depth", () => {
    expect(DEPTH_CONFIG.quick.gapPasses).toBe(0);
    expect(DEPTH_CONFIG.standard.gapPasses).toBe(1);
    expect(DEPTH_CONFIG.deep.gapPasses).toBe(2);
  });
});
