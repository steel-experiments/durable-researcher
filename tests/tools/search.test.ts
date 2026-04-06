// ABOUTME: Tests for the web_search tool's URL deduplication logic.
// ABOUTME: Tests extraction of search results from Steel scrape responses.

import { describe, it, expect } from "vitest";
import { extractSearchResults } from "../../src/steel-client.js";
import type { ScrapeResponse } from "steel-sdk/resources/top-level.js";

describe("extractSearchResults", () => {
  it("extracts results from structured links", () => {
    const response: ScrapeResponse = {
      content: {},
      links: [
        { text: "Result One", url: "https://example.com/one" },
        { text: "Result Two", url: "https://example.com/two" },
      ],
      metadata: { statusCode: 200 },
    };

    const results = extractSearchResults(response);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Result One");
    expect(results[0].url).toBe("https://example.com/one");
  });

  it("filters out blocked domains", () => {
    const response: ScrapeResponse = {
      content: {},
      links: [
        { text: "Google", url: "https://www.google.com/settings" },
        { text: "YouTube", url: "https://www.youtube.com/watch" },
        { text: "Good Result", url: "https://example.com/good" },
      ],
      metadata: { statusCode: 200 },
    };

    const results = extractSearchResults(response);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Good Result");
  });

  it("deduplicates URLs", () => {
    const response: ScrapeResponse = {
      content: {},
      links: [
        { text: "First", url: "https://example.com/page" },
        { text: "Duplicate", url: "https://example.com/page" },
      ],
      metadata: { statusCode: 200 },
    };

    const results = extractSearchResults(response);
    expect(results).toHaveLength(1);
  });

  it("falls back to markdown link parsing when links are sparse", () => {
    const response: ScrapeResponse = {
      content: {
        markdown:
          "Check out [Article A](https://example.com/a) and [Article B](https://example.com/b)",
      },
      links: [],
      metadata: { statusCode: 200 },
    };

    const results = extractSearchResults(response);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Article A");
  });

  it("limits results to 15", () => {
    const links = Array.from({ length: 20 }, (_, i) => ({
      text: `Result ${i}`,
      url: `https://example${i}.com/page`,
    }));

    const response: ScrapeResponse = {
      content: {},
      links,
      metadata: { statusCode: 200 },
    };

    const results = extractSearchResults(response);
    expect(results).toHaveLength(15);
  });

  it("skips non-http links", () => {
    const response: ScrapeResponse = {
      content: {},
      links: [
        { text: "JS Link", url: "javascript:void(0)" },
        { text: "Anchor", url: "#section" },
        { text: "Valid", url: "https://example.com/valid" },
      ],
      metadata: { statusCode: 200 },
    };

    const results = extractSearchResults(response);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Valid");
  });
});
