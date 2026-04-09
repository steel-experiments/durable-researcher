// ABOUTME: Tests for the web_search tool's URL deduplication logic.
// ABOUTME: Tests extraction of search results from Steel scrape responses.

import { describe, it, expect } from "vitest";
import { extractSearchResults, scoreRelevance, filterByRelevance } from "../../src/steel-client.js";
import type { ScrapeResponse } from "steel-sdk/resources/top-level.js";
import type { SearchResult } from "../../src/types.js";

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

  it("filters out newly blocked domains (dictionaries, shopping, social)", () => {
    const response: ScrapeResponse = {
      content: {},
      links: [
        { text: "Dict result", url: "https://dict.leo.org/agent" },
        { text: "WhatsApp", url: "https://web.whatsapp.com" },
        { text: "Amazon product", url: "https://www.amazon.com/product" },
        { text: "Good Result", url: "https://example.com/good" },
      ],
      metadata: { statusCode: 200 },
    };

    const results = extractSearchResults(response);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Good Result");
  });
});

describe("scoreRelevance", () => {
  const topic = "AI agent automation web infrastructure";

  it("scores highly relevant results above threshold", () => {
    const result: SearchResult = {
      title: "Building AI Agent Infrastructure for the Web",
      url: "https://example.com/ai-agents",
      snippet: "How to build reliable agent automation infrastructure",
    };
    const score = scoreRelevance(result, topic);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it("scores single-keyword matches as zero", () => {
    const result: SearchResult = {
      title: "WhatsApp Web",
      url: "https://web.whatsapp.com",
      snippet: "Send and receive messages on your computer",
    };
    const score = scoreRelevance(result, topic);
    // Single keyword match is not enough — requires at least 2
    expect(score).toBe(0);
  });

  it("scores one-word topics when the result clearly matches", () => {
    const result: SearchResult = {
      title: "OpenAI launches new API",
      url: "https://openai.com/blog/new-api",
      snippet: "New API features from OpenAI",
    };
    expect(scoreRelevance(result, "OpenAI")).toBeGreaterThan(0);
  });

  it("scores dictionary pages matching one topic word as zero", () => {
    const result: SearchResult = {
      title: "TRUSTWORTHY Definition & Meaning - Merriam-Webster",
      url: "https://merriam-webster.com/dictionary/trustworthy",
      snippet: "Definition of trustworthy: worthy of confidence",
    };
    // "trustworthy" is only 1 keyword match
    expect(scoreRelevance(result, "AI agent automation web infrastructure trustworthy")).toBe(0);
  });

  it("scores dictionary/translation results lower than relevant results", () => {
    const dictResult: SearchResult = {
      title: "agent - LEO: Übersetzung im Englisch ⇔ Deutsch Wörterbuch",
      url: "https://dict.leo.org/agent",
      snippet: "Translation for agent in the German-English dictionary",
    };
    const relevantResult: SearchResult = {
      title: "Building AI Agent Infrastructure for Web Automation",
      url: "https://example.com/ai-agents",
      snippet: "How to build reliable agent automation infrastructure",
    };
    const dictScore = scoreRelevance(dictResult, topic);
    const relevantScore = scoreRelevance(relevantResult, topic);
    // Dictionary result should score much lower than a relevant result
    expect(relevantScore).toBeGreaterThan(dictScore * 2);
  });

  it("scores product pages for wrong 'autonomous' low", () => {
    const result: SearchResult = {
      title: "Height Adjustable Electric Standing Desks | Autonomous",
      url: "https://www.autonomous.ai/standing-desks",
      snippet: "Shop ergonomic standing desks and office furniture",
    };
    const score = scoreRelevance(result, topic);
    expect(score).toBeLessThan(0.2);
  });

  it("handles empty title and snippet", () => {
    const result: SearchResult = { title: "", url: "https://example.com", snippet: "" };
    expect(scoreRelevance(result, topic)).toBe(0);
  });
});

describe("filterByRelevance", () => {
  const topic = "AI agent automation web infrastructure";

  it("removes irrelevant results and keeps relevant ones", () => {
    const results: SearchResult[] = [
      { title: "AI Agent Infrastructure Guide", url: "https://a.com", snippet: "Building reliable agent automation" },
      { title: "WhatsApp Web", url: "https://b.com", snippet: "Chat messaging app" },
      { title: "Standing Desks by Autonomous", url: "https://c.com", snippet: "Office furniture" },
      { title: "Web Agents and Trustworthy AI", url: "https://d.com", snippet: "How to make agents reliable" },
      { title: "Agent Infrastructure for Autonomous AI", url: "https://e.com", snippet: "Reliable web agent systems" },
      { title: "Cooking Recipes Blog", url: "https://f.com", snippet: "Delicious pasta recipes" },
    ];
    const filtered = filterByRelevance(results, topic);
    // Relevant results should be kept
    expect(filtered.some((r) => r.url === "https://a.com")).toBe(true);
    expect(filtered.some((r) => r.url === "https://d.com")).toBe(true);
    expect(filtered.some((r) => r.url === "https://e.com")).toBe(true);
    // Clearly irrelevant should be dropped
    expect(filtered.some((r) => r.title === "Cooking Recipes Blog")).toBe(false);
  });

  it("returns all results when all are relevant", () => {
    const results: SearchResult[] = [
      { title: "AI Agent Infrastructure", url: "https://a.com", snippet: "Agent automation for the web" },
      { title: "Web Infrastructure for AI", url: "https://b.com", snippet: "Building reliable AI infrastructure" },
    ];
    const filtered = filterByRelevance(results, topic);
    expect(filtered).toHaveLength(2);
  });

  it("returns empty when no results are relevant", () => {
    const results: SearchResult[] = [
      { title: "Random Page One", url: "https://a.com", snippet: "Nothing related" },
      { title: "Random Page Two", url: "https://b.com", snippet: "Also unrelated" },
      { title: "Standing Desks", url: "https://c.com", snippet: "Office furniture" },
    ];
    const filtered = filterByRelevance(results, topic);
    expect(filtered).toHaveLength(0);
  });

  it("keeps relevant results for one-word topics", () => {
    const results: SearchResult[] = [
      { title: "OpenAI launches new API", url: "https://openai.com/blog", snippet: "New API capabilities" },
      { title: "Cooking Recipes Blog", url: "https://example.com/recipes", snippet: "Pasta and soup ideas" },
    ];
    const filtered = filterByRelevance(results, "OpenAI");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toBe("https://openai.com/blog");
  });
});
