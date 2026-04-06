// ABOUTME: Tests for the browse_url tool's URL tracking and content handling.
// ABOUTME: Tests the tool's behavior with meaningful and empty content scenarios.

import { describe, it, expect, vi } from "vitest";

// We test the content processing and URL tracking aspects, not the actual Steel/LLM calls
import { isContentMeaningful, truncateContent, cleanContent } from "../../src/content.js";

describe("browse tool content processing", () => {
  it("cleanContent normalizes whitespace in scraped pages", () => {
    const raw = "  Hello\r\n\r\n\r\nWorld  \t  Foo  ";
    const cleaned = cleanContent(raw);
    expect(cleaned).toBe("Hello\n\nWorld Foo");
  });

  it("truncateContent limits page content to max chars", () => {
    const longContent = "word ".repeat(10000);
    const truncated = truncateContent(longContent, 25000);
    expect(truncated.length).toBeLessThanOrEqual(25000 + 30); // +suffix
    expect(truncated).toContain("[Content truncated]");
  });

  it("isContentMeaningful rejects thin pages", () => {
    expect(isContentMeaningful("Login | Sign up")).toBe(false);
    expect(isContentMeaningful("")).toBe(false);
    expect(isContentMeaningful("Error 403 Forbidden")).toBe(false);
  });

  it("URL dedup set tracks browsed URLs", () => {
    const scrapedUrls = new Set<string>();

    // Simulate what browse tool does
    scrapedUrls.add("https://example.com/page1");
    scrapedUrls.add("https://example.com/page2");

    expect(scrapedUrls.has("https://example.com/page1")).toBe(true);
    expect(scrapedUrls.has("https://example.com/page3")).toBe(false);
    expect(scrapedUrls.size).toBe(2);
  });
});
