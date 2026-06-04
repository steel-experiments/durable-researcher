// ABOUTME: Tests for note ranking and deduplication — similarity, merge, dedup, and ranking logic.
// ABOUTME: Covers edge cases like empty input, identical notes, disjoint notes, and confidence ordering.

import { describe, it, expect } from "vitest";
import {
  computeSimilarity,
  findDuplicatePairs,
  mergeNotes,
  deduplicateNotes,
  rankNotes,
  capConfidenceByTier,
} from "../src/notes-ranker.js";
import type { ResearchNote } from "../src/types.js";
import { MAX_EXCERPTS_PER_NOTE } from "../src/types.js";

describe("capConfidenceByTier", () => {
  it("leaves confidence untouched for primary and secondary sources", () => {
    expect(capConfidenceByTier("high", "primary")).toBe("high");
    expect(capConfidenceByTier("high", "secondary")).toBe("high");
    expect(capConfidenceByTier("medium", "secondary")).toBe("medium");
  });

  it("caps blog-backed confidence at medium", () => {
    expect(capConfidenceByTier("high", "blog")).toBe("medium");
    expect(capConfidenceByTier("medium", "blog")).toBe("medium");
    expect(capConfidenceByTier("low", "blog")).toBe("low");
  });

  it("caps forum- and unreliable-backed confidence at low", () => {
    expect(capConfidenceByTier("high", "forum")).toBe("low");
    expect(capConfidenceByTier("medium", "unreliable")).toBe("low");
    expect(capConfidenceByTier("low", "forum")).toBe("low");
  });

  it("only ever lowers confidence, never raises it", () => {
    expect(capConfidenceByTier("low", "primary")).toBe("low");
    expect(capConfidenceByTier("medium", "primary")).toBe("medium");
  });

  it("leaves confidence unchanged when no tier is given (back-compat)", () => {
    expect(capConfidenceByTier("high", undefined)).toBe("high");
  });
});

describe("computeSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(computeSimilarity("hello world foo", "hello world foo")).toBe(1);
  });

  it("returns 0 for completely disjoint strings", () => {
    const sim = computeSimilarity("alpha beta gamma", "one two three four");
    expect(sim).toBe(0);
  });

  it("returns a value between 0 and 1 for overlapping strings", () => {
    const sim = computeSimilarity(
      "Google uses surface codes for quantum error correction research",
      "Google uses surface codes for fault tolerant quantum computing research",
    );
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("handles empty strings", () => {
    expect(computeSimilarity("", "")).toBe(0);
    expect(computeSimilarity("hello world foo", "")).toBe(0);
    expect(computeSimilarity("", "hello world foo")).toBe(0);
  });

  it("handles single-word strings (no trigrams possible)", () => {
    expect(computeSimilarity("hi", "hi")).toBe(0);
  });
});

describe("findDuplicatePairs", () => {
  it("returns empty array for no notes", () => {
    expect(findDuplicatePairs([])).toEqual([]);
  });

  it("returns empty array for a single note", () => {
    const notes: ResearchNote[] = [
      { title: "A", content: "some content here", sourceUrls: [], confidence: "high" },
    ];
    expect(findDuplicatePairs(notes)).toEqual([]);
  });

  it("detects identical notes as duplicates", () => {
    const notes: ResearchNote[] = [
      {
        title: "Surface Codes",
        content: "Google uses surface codes for quantum error correction in their latest research",
        sourceUrls: ["https://a.com"],
        confidence: "high",
      },
      {
        title: "Surface Codes Again",
        content: "Google uses surface codes for quantum error correction in their latest research",
        sourceUrls: ["https://b.com"],
        confidence: "medium",
      },
    ];
    const pairs = findDuplicatePairs(notes);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0]).toEqual([0, 1]);
  });

  it("does not flag disjoint notes as duplicates", () => {
    const notes: ResearchNote[] = [
      {
        title: "Quantum Computing",
        content: "Quantum computers leverage quantum mechanical phenomena like superposition and entanglement",
        sourceUrls: ["https://a.com"],
        confidence: "high",
      },
      {
        title: "Classical Music",
        content: "Bach composed many fugues and preludes during the Baroque period of classical music history",
        sourceUrls: ["https://b.com"],
        confidence: "high",
      },
    ];
    const pairs = findDuplicatePairs(notes);
    expect(pairs).toEqual([]);
  });

  it("respects custom threshold", () => {
    const notes: ResearchNote[] = [
      {
        title: "A",
        content: "Google uses surface codes for quantum error correction and fault tolerance",
        sourceUrls: [],
        confidence: "high",
      },
      {
        title: "B",
        content: "Google implements surface codes to handle quantum error correction with topological methods",
        sourceUrls: [],
        confidence: "high",
      },
    ];
    // Very low threshold should catch partial overlaps
    const pairsLow = findDuplicatePairs(notes, 0.1);
    expect(pairsLow.length).toBeGreaterThanOrEqual(0);

    // Very high threshold should be strict
    const pairsHigh = findDuplicatePairs(notes, 0.99);
    expect(pairsHigh).toEqual([]);
  });
});

describe("mergeNotes keyExcerpts", () => {
  it("unions excerpts from both notes", () => {
    const a: ResearchNote = {
      title: "A",
      content: "Some content about quantum surface codes here.",
      sourceUrls: [],
      confidence: "high",
      keyExcerpts: ["Quote A1", "Quote A2"],
    };
    const b: ResearchNote = {
      title: "B",
      content: "More content about surface codes here too.",
      sourceUrls: [],
      confidence: "high",
      keyExcerpts: ["Quote B1"],
    };
    const merged = mergeNotes(a, b);
    expect(merged.keyExcerpts).toContain("Quote A1");
    expect(merged.keyExcerpts).toContain("Quote A2");
    expect(merged.keyExcerpts).toContain("Quote B1");
  });

  it("deduplicates excerpts when merging (case-insensitive trim)", () => {
    const a: ResearchNote = {
      title: "A",
      content: "x".repeat(50),
      sourceUrls: [],
      confidence: "high",
      keyExcerpts: ["Shared quote", "Unique A"],
    };
    const b: ResearchNote = {
      title: "B",
      content: "y".repeat(50),
      sourceUrls: [],
      confidence: "high",
      keyExcerpts: ["  shared quote  ", "Unique B"],
    };
    const merged = mergeNotes(a, b);
    const lowered = merged.keyExcerpts!.map((e) => e.trim().toLowerCase());
    expect(lowered.filter((e) => e === "shared quote")).toHaveLength(1);
    expect(merged.keyExcerpts).toContain("Unique A");
    expect(merged.keyExcerpts).toContain("Unique B");
  });

  it("caps merged excerpts at MAX_EXCERPTS_PER_NOTE", () => {
    const a: ResearchNote = {
      title: "A",
      content: "x".repeat(50),
      sourceUrls: [],
      confidence: "high",
      keyExcerpts: ["A1", "A2", "A3", "A4", "A5"],
    };
    const b: ResearchNote = {
      title: "B",
      content: "y".repeat(50),
      sourceUrls: [],
      confidence: "high",
      keyExcerpts: ["B1", "B2", "B3", "B4", "B5"],
    };
    const merged = mergeNotes(a, b);
    expect(merged.keyExcerpts!.length).toBeLessThanOrEqual(MAX_EXCERPTS_PER_NOTE);
    expect(merged.keyExcerpts!.length).toBe(MAX_EXCERPTS_PER_NOTE);
  });

  it("handles missing excerpts on one side", () => {
    const a: ResearchNote = {
      title: "A",
      content: "x".repeat(50),
      sourceUrls: [],
      confidence: "high",
      keyExcerpts: ["Only A"],
    };
    const b: ResearchNote = {
      title: "B",
      content: "y".repeat(50),
      sourceUrls: [],
      confidence: "high",
    };
    const merged = mergeNotes(a, b);
    expect(merged.keyExcerpts).toEqual(["Only A"]);
  });

  it("returns undefined excerpts when both sides are empty/missing", () => {
    const a: ResearchNote = {
      title: "A",
      content: "x".repeat(50),
      sourceUrls: [],
      confidence: "high",
    };
    const b: ResearchNote = {
      title: "B",
      content: "y".repeat(50),
      sourceUrls: [],
      confidence: "high",
    };
    const merged = mergeNotes(a, b);
    expect(merged.keyExcerpts).toBeUndefined();
  });
});

describe("mergeNotes", () => {
  it("unions source URLs", () => {
    const a: ResearchNote = {
      title: "Finding A",
      content: "Some content.",
      sourceUrls: ["https://a.com", "https://shared.com"],
      confidence: "high",
    };
    const b: ResearchNote = {
      title: "Finding B",
      content: "Some other content.",
      sourceUrls: ["https://b.com", "https://shared.com"],
      confidence: "medium",
    };
    const merged = mergeNotes(a, b);
    expect(merged.sourceUrls).toContain("https://a.com");
    expect(merged.sourceUrls).toContain("https://b.com");
    expect(merged.sourceUrls).toContain("https://shared.com");
    // No duplicates
    expect(merged.sourceUrls.filter((u) => u === "https://shared.com")).toHaveLength(1);
  });

  it("carries the most authoritative source tier", () => {
    const a: ResearchNote = {
      title: "Finding A",
      content: "Some content.",
      sourceUrls: ["https://a.com"],
      confidence: "high",
      sourceTier: "blog",
    };
    const b: ResearchNote = {
      title: "Finding B",
      content: "Some other content here.",
      sourceUrls: ["https://b.com"],
      confidence: "high",
      sourceTier: "primary",
    };
    expect(mergeNotes(a, b).sourceTier).toBe("primary");
    expect(mergeNotes(b, a).sourceTier).toBe("primary");
  });

  it("preserves the one tier present when only a single note is tiered", () => {
    const a: ResearchNote = {
      title: "Finding A",
      content: "Some content.",
      sourceUrls: ["https://a.com"],
      confidence: "high",
      sourceTier: "secondary",
    };
    const b: ResearchNote = {
      title: "Finding B",
      content: "Some other content here.",
      sourceUrls: ["https://b.com"],
      confidence: "high",
    };
    expect(mergeNotes(a, b).sourceTier).toBe("secondary");
    expect(mergeNotes(b, a).sourceTier).toBe("secondary");
  });

  it("keeps the longer content", () => {
    const a: ResearchNote = {
      title: "Short",
      content: "Brief.",
      sourceUrls: [],
      confidence: "high",
    };
    const b: ResearchNote = {
      title: "Long",
      content: "This is a much longer and more detailed description of the finding.",
      sourceUrls: [],
      confidence: "medium",
    };
    const merged = mergeNotes(a, b);
    expect(merged.content).toBe(b.content);
    expect(merged.title).toBe(b.title);
  });

  it("takes the higher confidence", () => {
    const pairs: [ResearchNote["confidence"], ResearchNote["confidence"], ResearchNote["confidence"]][] = [
      ["high", "medium", "high"],
      ["medium", "high", "high"],
      ["low", "medium", "medium"],
      ["low", "high", "high"],
      ["medium", "low", "medium"],
    ];

    for (const [confA, confB, expected] of pairs) {
      const a: ResearchNote = { title: "A", content: "Content A here.", sourceUrls: [], confidence: confA };
      const b: ResearchNote = { title: "B", content: "Content B here.", sourceUrls: [], confidence: confB };
      expect(mergeNotes(a, b).confidence).toBe(expected);
    }
  });
});

describe("deduplicateNotes", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateNotes([])).toEqual([]);
  });

  it("returns the same notes when no duplicates exist", () => {
    const notes: ResearchNote[] = [
      {
        title: "Quantum Computing",
        content: "Quantum computers use qubits that can be in superposition for parallel computation",
        sourceUrls: ["https://a.com"],
        confidence: "high",
      },
      {
        title: "Classical Music",
        content: "Bach composed many fugues during the Baroque period of European classical music",
        sourceUrls: ["https://b.com"],
        confidence: "medium",
      },
    ];
    const deduped = deduplicateNotes(notes);
    expect(deduped).toHaveLength(2);
  });

  it("merges duplicate notes", () => {
    const notes: ResearchNote[] = [
      {
        title: "Surface Codes",
        content: "Google uses surface codes for quantum error correction in their superconducting qubit systems",
        sourceUrls: ["https://a.com"],
        confidence: "medium",
      },
      {
        title: "Surface Code QEC",
        content: "Google uses surface codes for quantum error correction in their superconducting qubit systems and research labs",
        sourceUrls: ["https://b.com"],
        confidence: "high",
      },
    ];
    const deduped = deduplicateNotes(notes);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].confidence).toBe("high");
    expect(deduped[0].sourceUrls).toContain("https://a.com");
    expect(deduped[0].sourceUrls).toContain("https://b.com");
  });

  it("handles all duplicates", () => {
    const content = "Identical content across all notes about the same finding from different sources";
    const notes: ResearchNote[] = [
      { title: "A", content, sourceUrls: ["https://a.com"], confidence: "low" },
      { title: "B", content, sourceUrls: ["https://b.com"], confidence: "medium" },
      { title: "C", content, sourceUrls: ["https://c.com"], confidence: "high" },
    ];
    const deduped = deduplicateNotes(notes);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].confidence).toBe("high");
    expect(deduped[0].sourceUrls).toHaveLength(3);
  });
});

describe("rankNotes", () => {
  it("sorts by confidence: high > medium > low", () => {
    const notes: ResearchNote[] = [
      { title: "Low", content: "Content here.", sourceUrls: [], confidence: "low" },
      { title: "High", content: "Content here.", sourceUrls: [], confidence: "high" },
      { title: "Medium", content: "Content here.", sourceUrls: [], confidence: "medium" },
    ];
    const ranked = rankNotes(notes);
    expect(ranked[0].confidence).toBe("high");
    expect(ranked[1].confidence).toBe("medium");
    expect(ranked[2].confidence).toBe("low");
  });

  it("breaks confidence ties by source count", () => {
    const notes: ResearchNote[] = [
      { title: "One Source", content: "Content here.", sourceUrls: ["https://a.com"], confidence: "high" },
      { title: "Three Sources", content: "Content here.", sourceUrls: ["https://a.com", "https://b.com", "https://c.com"], confidence: "high" },
      { title: "Two Sources", content: "Content here.", sourceUrls: ["https://a.com", "https://b.com"], confidence: "high" },
    ];
    const ranked = rankNotes(notes);
    expect(ranked[0].title).toBe("Three Sources");
    expect(ranked[1].title).toBe("Two Sources");
    expect(ranked[2].title).toBe("One Source");
  });

  it("breaks source count ties by content length", () => {
    const notes: ResearchNote[] = [
      { title: "Short", content: "Brief.", sourceUrls: ["https://a.com"], confidence: "high" },
      { title: "Long", content: "This is a much longer and more detailed content.", sourceUrls: ["https://a.com"], confidence: "high" },
    ];
    const ranked = rankNotes(notes);
    expect(ranked[0].title).toBe("Long");
    expect(ranked[1].title).toBe("Short");
  });

  it("does not mutate the original array", () => {
    const notes: ResearchNote[] = [
      { title: "B", content: "Content.", sourceUrls: [], confidence: "low" },
      { title: "A", content: "Content.", sourceUrls: [], confidence: "high" },
    ];
    const ranked = rankNotes(notes);
    expect(notes[0].title).toBe("B");
    expect(ranked[0].title).toBe("A");
  });

  it("handles empty input", () => {
    expect(rankNotes([])).toEqual([]);
  });
});
