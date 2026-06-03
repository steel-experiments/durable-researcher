// ABOUTME: Snapshot-light tests for prompt templates — verifies key instructions are present.
// ABOUTME: Templates render without LLM calls so these tests are deterministic.

import { describe, it, expect } from "vitest";
import { loadTemplate } from "../src/prompts.js";

describe("plan.hbs template", () => {
  it("instructs the planner to cover lensed angles (definition / recency / criticism / comparison / primary)", async () => {
    const rendered = await loadTemplate("plan", { maxQueries: "5", depth: "standard" });
    const lowered = rendered.toLowerCase();
    expect(lowered).toContain("definition");
    expect(lowered).toContain("recency");
    expect(lowered).toContain("criticism");
    expect(lowered).toContain("comparison");
    expect(lowered).toContain("primary source");
  });

  it("requests the configured number of queries", async () => {
    const rendered = await loadTemplate("plan", { maxQueries: "7", depth: "standard" });
    expect(rendered).toContain("7");
  });

  it("renders the depth-specific guidance for 'deep'", async () => {
    const rendered = await loadTemplate("plan", { maxQueries: "3", depth: "deep" });
    expect(rendered.toLowerCase()).toContain("deep");
  });

  it("instructs the planner to interpret oblique phrasing with lateral thinking before searching", async () => {
    const rendered = await loadTemplate("plan", { maxQueries: "5", depth: "standard" });
    const lowered = rendered.toLowerCase();
    // The lateral-interpretation step must be present and generic (renders for any mode).
    expect(lowered).toContain("lateral");
    expect(lowered).toContain("indirect reference");
    expect(lowered).toContain("homophone");
    // It must force the model to record interpretations before queries.
    expect(lowered).toContain("interpretations");
    // It must cover queries for both the literal and the lateral readings.
    expect(lowered).toMatch(/literal[\s\S]*lateral|lateral[\s\S]*literal/);
  });

  it("treats user-stated details as fallible clues and infers associations before searching", async () => {
    const rendered = await loadTemplate("plan", { maxQueries: "5", depth: "standard" });
    const lowered = rendered.toLowerCase();
    // The user may be wrong, imprecise, or jotting loose associations from memory.
    expect(lowered).toMatch(/wrong|mistaken|approximate|imprecise/);
    expect(lowered).toContain("association");
    // The planner should infer what the clues point at before searching, and relax
    // unreliable details rather than treating every word as a hard constraint.
    expect(lowered).toContain("infer");
    expect(lowered).toMatch(/soft clue|hard constraint|relax|drop the least/);
  });

  it("guards against inventing wordplay where the phrasing is straightforward", async () => {
    const rendered = await loadTemplate("plan", { maxQueries: "5", depth: "standard" });
    const lowered = rendered.toLowerCase();
    // The "solve but don't optimize for them" guardrail: do not hallucinate puns on plain topics.
    expect(lowered).toMatch(/do not invent|nothing is oblique|single literal interpretation/);
  });

  it("does not reference the bubble-gum needle task in the prompt", async () => {
    const rendered = await loadTemplate("plan", { maxQueries: "5", depth: "standard" });
    expect(rendered.toLowerCase()).not.toContain("bubble gum");
    expect(rendered.toLowerCase()).not.toContain("bubba gump");
  });
});

describe("summarize.hbs template", () => {
  it("asks for verbatim key excerpts alongside the summary", async () => {
    const rendered = await loadTemplate("summarize", { topic: "quantum error correction" });
    const lowered = rendered.toLowerCase();
    expect(lowered).toContain("key excerpts");
    expect(lowered).toContain("verbatim");
  });

  it("preserves the existing focus and topic interpolation", async () => {
    const rendered = await loadTemplate("summarize", {
      topic: "quantum error correction",
      focus: "error rates",
    });
    expect(rendered).toContain("error rates");
    expect(rendered).toContain("quantum error correction");
  });
});

describe("system.hbs template", () => {
  it("instructs the agent to use the EDGAR source for SEC filings", async () => {
    const rendered = await loadTemplate("system", {
      topic: "Apple 10-K cash flow",
      depth: "standard",
      mode: "extraction",
      maxSources: 20,
      maxIterations: 3,
    });
    const lowered = rendered.toLowerCase();
    expect(lowered).toContain("edgar");
    expect(lowered).toMatch(/source:\s*["']?edgar["']?/);
    expect(lowered).toMatch(/10-?k|10-?q|sec filing/);
  });

  it("requires keyExcerpts on high-confidence notes", async () => {
    const rendered = await loadTemplate("system", {
      topic: "x",
      depth: "standard",
      mode: "synthesis",
      maxSources: 20,
      maxIterations: 3,
    });
    expect(rendered.toLowerCase()).toContain("keyexcerpts");
    expect(rendered.toLowerCase()).toContain("verbatim");
  });

  it("requires numeric inline citations instead of markdown author links", async () => {
    const rendered = await loadTemplate("system", {
      topic: "x",
      depth: "standard",
      mode: "synthesis",
      maxSources: 20,
      maxIterations: 3,
    });
    expect(rendered).toContain("numeric inline citations");
    expect(rendered).toContain("[1]");
    expect(rendered).toContain("Do NOT use markdown author links");
  });

  it("renders the lookup-mode shape when mode=lookup", async () => {
    const rendered = await loadTemplate("system", {
      topic: "x",
      depth: "standard",
      mode: "lookup",
      maxSources: 20,
      maxIterations: 3,
    });
    const lowered = rendered.toLowerCase();
    expect(lowered).toContain("lookup");
    expect(lowered).toMatch(/answer first|direct answer/);
    expect(lowered).not.toContain("evidence table");
  });

  it("renders the extraction-mode shape when mode=extraction", async () => {
    const rendered = await loadTemplate("system", {
      topic: "x",
      depth: "standard",
      mode: "extraction",
      maxSources: 20,
      maxIterations: 3,
    });
    const lowered = rendered.toLowerCase();
    expect(lowered).toContain("evidence table");
    expect(lowered).toMatch(/metric.*value.*period|metric.*value.*source/);
  });

  it("renders the synthesis-mode (default) shape when mode=synthesis", async () => {
    const rendered = await loadTemplate("system", {
      topic: "x",
      depth: "standard",
      mode: "synthesis",
      maxSources: 20,
      maxIterations: 3,
    });
    expect(rendered).toContain("Executive Summary");
    expect(rendered).toContain("Detailed Findings");
  });
});
