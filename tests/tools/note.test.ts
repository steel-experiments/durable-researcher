// ABOUTME: Tests for the take_note tool.
// ABOUTME: Verifies note recording, accumulation, and result formatting.

import { describe, it, expect } from "vitest";
import { createNoteTool } from "../../src/tools/note.js";
import type { ResearchNote } from "../../src/types.js";
import { MAX_EXCERPTS_PER_NOTE } from "../../src/types.js";

describe("createNoteTool", () => {
  it("appends a note to the notes array", async () => {
    const notes: ResearchNote[] = [];
    const tool = createNoteTool(notes);

    await tool.execute("call-1", {
      title: "Quantum Error Rates",
      content: "Google achieved 1% error rate in 2025",
      sourceUrls: ["https://example.com/quantum"],
      confidence: "high" as const,
    });

    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Quantum Error Rates");
    expect(notes[0].confidence).toBe("high");
  });

  it("accumulates multiple notes", async () => {
    const notes: ResearchNote[] = [];
    const tool = createNoteTool(notes);

    await tool.execute("call-1", {
      title: "First Finding",
      content: "Content A",
      sourceUrls: ["https://a.com"],
      confidence: "high" as const,
    });

    await tool.execute("call-2", {
      title: "Second Finding",
      content: "Content B",
      sourceUrls: ["https://b.com"],
      confidence: "medium" as const,
    });

    expect(notes).toHaveLength(2);
    expect(notes[1].title).toBe("Second Finding");
  });

  it("returns confirmation text with note count", async () => {
    const notes: ResearchNote[] = [];
    const tool = createNoteTool(notes);

    const result = await tool.execute("call-1", {
      title: "Test Note",
      content: "Test content",
      sourceUrls: [],
      confidence: "low" as const,
    });

    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Total notes: 1"),
      }),
    );
  });

  it("returns note index in details", async () => {
    const notes: ResearchNote[] = [
      {
        title: "Existing",
        content: "Pre-existing note",
        sourceUrls: [],
        confidence: "high",
      },
    ];
    const tool = createNoteTool(notes);

    const result = await tool.execute("call-1", {
      title: "New Note",
      content: "New content",
      sourceUrls: [],
      confidence: "medium" as const,
    });

    expect(result.details).toEqual({ noteIndex: 1, mergedCount: 0 });
  });

  it("stores keyExcerpts when provided", async () => {
    const notes: ResearchNote[] = [];
    const tool = createNoteTool(notes);

    await tool.execute("call-1", {
      title: "Quote-bearing finding",
      content: "Surface codes used in qubit error correction",
      sourceUrls: ["https://example.com"],
      confidence: "high" as const,
      keyExcerpts: [
        "Surface codes are the leading approach",
        "Logical error rate dropped to 0.143%",
      ],
    });

    expect(notes[0].keyExcerpts).toEqual([
      "Surface codes are the leading approach",
      "Logical error rate dropped to 0.143%",
    ]);
  });

  it("caps keyExcerpts at MAX_EXCERPTS_PER_NOTE and trims each to 240 chars", async () => {
    const notes: ResearchNote[] = [];
    const tool = createNoteTool(notes);
    const longQuote = "x".repeat(300);

    await tool.execute("call-1", {
      title: "Too many excerpts",
      content: "Content",
      sourceUrls: [],
      confidence: "medium" as const,
      keyExcerpts: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", longQuote],
    });

    expect(notes[0].keyExcerpts).toHaveLength(MAX_EXCERPTS_PER_NOTE);
    expect(MAX_EXCERPTS_PER_NOTE).toBe(8);
    for (const ex of notes[0].keyExcerpts!) {
      expect(ex.length).toBeLessThanOrEqual(240);
    }
  });

  it("works without keyExcerpts (backwards compat)", async () => {
    const notes: ResearchNote[] = [];
    const tool = createNoteTool(notes);

    await tool.execute("call-1", {
      title: "Legacy note",
      content: "No excerpts",
      sourceUrls: [],
      confidence: "low" as const,
    });

    expect(notes[0].keyExcerpts).toBeUndefined();
  });

  it("triggers dedup when notes reach threshold", async () => {
    const notes: ResearchNote[] = [];
    const tool = createNoteTool(notes);

    // Add 7 unique notes (below threshold of 8)
    for (let i = 0; i < 7; i++) {
      await tool.execute(`call-${i}`, {
        title: `Unique Finding ${i}`,
        content: `Completely unique content about topic number ${i} with enough words to form trigrams properly`,
        sourceUrls: [`https://source${i}.com`],
        confidence: "high" as const,
      });
    }
    expect(notes).toHaveLength(7);

    // Add a duplicate of note 0 — this is note 8, triggering dedup
    const result = await tool.execute("call-dup", {
      title: "Unique Finding 0 Duplicate",
      content: "Completely unique content about topic number 0 with enough words to form trigrams properly",
      sourceUrls: ["https://another-source.com"],
      confidence: "medium" as const,
    });

    // Should have merged the duplicate
    expect(notes.length).toBeLessThan(8);
    expect(result.content[0].text).toContain("merged");
  });
});
