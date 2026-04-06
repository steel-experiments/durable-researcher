// ABOUTME: Tests for content processing utilities.
// ABOUTME: Covers truncation, cleaning, meaningfulness checking, and token estimation.

import { describe, it, expect } from "vitest";
import {
  truncateContent,
  cleanContent,
  isContentMeaningful,
  estimateTokens,
} from "../src/content.js";

describe("truncateContent", () => {
  it("returns text unchanged when under limit", () => {
    const text = "Hello world";
    expect(truncateContent(text, 100)).toBe(text);
  });

  it("truncates at word boundary when over limit", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const result = truncateContent(text, 20);
    expect(result).toContain("[Content truncated]");
    expect(result.length).toBeLessThan(text.length + 30);
    // Should not contain the full original text
    expect(result).not.toContain("lazy dog");
  });

  it("uses custom suffix", () => {
    const text = "a ".repeat(100);
    const result = truncateContent(text, 20, "...");
    expect(result).toEndWith("...");
  });

  it("handles text with no spaces gracefully", () => {
    const text = "a".repeat(100);
    const result = truncateContent(text, 50);
    expect(result).toContain("[Content truncated]");
  });
});

describe("cleanContent", () => {
  it("normalizes CRLF to LF", () => {
    expect(cleanContent("hello\r\nworld")).toBe("hello\nworld");
  });

  it("collapses multiple blank lines", () => {
    expect(cleanContent("hello\n\n\n\n\nworld")).toBe("hello\n\nworld");
  });

  it("collapses multiple spaces", () => {
    expect(cleanContent("hello    world")).toBe("hello world");
  });

  it("replaces tabs with spaces", () => {
    expect(cleanContent("hello\tworld")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(cleanContent("  hello  ")).toBe("hello");
  });
});

describe("isContentMeaningful", () => {
  it("rejects very short text", () => {
    expect(isContentMeaningful("too short")).toBe(false);
  });

  it("rejects text with too few words", () => {
    // Long string but few actual words
    const text = "word ".repeat(10) + "a".repeat(200);
    expect(isContentMeaningful(text, 50)).toBe(false);
  });

  it("rejects repetitive boilerplate", () => {
    // Same word repeated many times — low uniqueness ratio
    const text = "cookie ".repeat(200);
    expect(isContentMeaningful(text)).toBe(false);
  });

  it("accepts diverse, substantial content", () => {
    const words = [
      "quantum", "computing", "represents", "a", "fundamental", "shift",
      "in", "how", "we", "process", "information", "using", "principles",
      "of", "superposition", "and", "entanglement", "to", "solve",
      "problems", "that", "classical", "computers", "cannot", "handle",
      "efficiently", "researchers", "have", "made", "significant",
      "progress", "in", "error", "correction", "which", "is", "essential",
      "for", "building", "practical", "fault", "tolerant", "machines",
      "the", "latest", "developments", "include", "surface", "codes",
      "topological", "qubits",
    ];
    const text = words.join(" ");
    expect(isContentMeaningful(text, 30, 100)).toBe(true);
  });
});

describe("estimateTokens", () => {
  it("estimates roughly 1 token per 4 chars", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up", () => {
    expect(estimateTokens("abcde")).toBe(2); // 5/4 = 1.25 → 2
  });
});
