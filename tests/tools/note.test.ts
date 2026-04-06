// ABOUTME: Tests for the take_note tool.
// ABOUTME: Verifies note recording, accumulation, and result formatting.

import { describe, it, expect } from "vitest";
import { createNoteTool } from "../../src/tools/note.js";
import type { ResearchNote } from "../../src/types.js";

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

    expect(result.details).toEqual({ noteIndex: 1 });
  });
});
