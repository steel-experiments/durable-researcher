// ABOUTME: Tests for the gap_analysis tool — JSON parsing, notes digest, and call-budget enforcement.
// ABOUTME: Uses an injected analyzer so no real LLM calls are made.

import { describe, it, expect } from "vitest";
import {
  createGapAnalysisTool,
  parseGapEntities,
  buildNotesDigest,
  type GapAnalyzer,
} from "../../src/tools/gap-analysis.js";
import type { ResearchNote } from "../../src/types.js";

const note = (title: string, content = "content"): ResearchNote => ({
  title,
  content,
  sourceUrls: ["https://a.com"],
  confidence: "high",
});

describe("parseGapEntities", () => {
  it("parses a clean JSON array", () => {
    const raw = '[{"name":"AGDebugger","kind":"system","why":"debugging UI"},{"name":"TRAIL","kind":"benchmark"}]';
    const out = parseGapEntities(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: "AGDebugger", kind: "system", why: "debugging UI" });
    expect(out[1]).toEqual({ name: "TRAIL", kind: "benchmark" });
  });

  it("extracts the array even with surrounding prose", () => {
    const raw = 'Here are the gaps:\n[{"name":"HULA","kind":"system"}]\nHope that helps.';
    const out = parseGapEntities(raw);
    expect(out).toEqual([{ name: "HULA", kind: "system" }]);
  });

  it("drops entries without a name and defaults missing kind", () => {
    const raw = '[{"kind":"paper"},{"name":"Magentic-One"}]';
    const out = parseGapEntities(raw);
    expect(out).toEqual([{ name: "Magentic-One", kind: "unknown" }]);
  });

  it("returns empty on null, non-array, or malformed input", () => {
    expect(parseGapEntities(null)).toEqual([]);
    expect(parseGapEntities("not json")).toEqual([]);
    expect(parseGapEntities('{"name":"x"}')).toEqual([]);
  });

  it("caps at 10 entities", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `E${i}`, kind: "system" }));
    const out = parseGapEntities(JSON.stringify(many));
    expect(out).toHaveLength(10);
  });
});

describe("buildNotesDigest", () => {
  it("notes the empty case", () => {
    expect(buildNotesDigest([])).toContain("no notes");
  });

  it("dedupes by title and truncates content", () => {
    const digest = buildNotesDigest([
      note("Alpha", "x".repeat(300)),
      note("Alpha", "duplicate title"),
      note("Beta"),
    ]);
    expect(digest).toContain("Alpha");
    expect(digest).toContain("Beta");
    // only one Alpha line
    expect(digest.match(/Alpha/g)).toHaveLength(1);
  });
});

describe("createGapAnalysisTool", () => {
  it("surfaces parsed entities with fill guidance", async () => {
    const analyzer: GapAnalyzer = async () =>
      '[{"name":"InterDeepResearch","kind":"system","why":"live steering"}]';
    const tool = createGapAnalysisTool({ notes: [note("Foo")], topic: "agent steering", maxCalls: 2, analyzer });
    const result = await tool.execute("c1", {});
    expect(result.content[0].text).toContain("InterDeepResearch");
    expect(result.content[0].text.toLowerCase()).toMatch(/find_entity|scout/);
    expect((result.details as any).entities).toHaveLength(1);
  });

  it("tells the agent to synthesize when no gaps are found", async () => {
    const analyzer: GapAnalyzer = async () => "[]";
    const tool = createGapAnalysisTool({ notes: [note("Foo")], topic: "t", maxCalls: 2, analyzer });
    const result = await tool.execute("c1", {});
    expect(result.content[0].text.toLowerCase()).toContain("synthesize");
    expect((result.details as any).entities).toEqual([]);
  });

  it("enforces the call budget and refuses beyond it", async () => {
    let calls = 0;
    const analyzer: GapAnalyzer = async () => {
      calls++;
      return '[{"name":"X","kind":"system"}]';
    };
    const tool = createGapAnalysisTool({ notes: [note("Foo")], topic: "t", maxCalls: 1, analyzer });
    const first = await tool.execute("c1", {});
    expect((first.details as any).entities).toHaveLength(1);
    const second = await tool.execute("c2", {});
    expect((second.details as any).exhausted).toBe(true);
    expect(second.content[0].text.toLowerCase()).toContain("budget exhausted");
    // analyzer not called the second time
    expect(calls).toBe(1);
  });

  it("degrades gracefully when the analyzer throws", async () => {
    const analyzer: GapAnalyzer = async () => {
      throw new Error("LLM down");
    };
    const tool = createGapAnalysisTool({ notes: [note("Foo")], topic: "t", maxCalls: 2, analyzer });
    const result = await tool.execute("c1", {});
    expect((result.details as any).error).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain("failed");
  });
});
