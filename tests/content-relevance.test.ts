// ABOUTME: Tests relevance scoring based on actual browsed content.
// ABOUTME: Locks the content-grounded signal used by browse/scout/prefetch.

import { describe, expect, it } from "vitest";
import { assessContentRelevance } from "../src/content-relevance.js";

describe("assessContentRelevance", () => {
  it("marks content relevant when the fetched page matches the topic", () => {
    const relevance = assessContentRelevance({
      title: "AI agent infrastructure",
      url: "https://example.com/agents",
      content: "This page covers agent automation, reliable web infrastructure, and evaluation.",
      topic: "AI agent automation web infrastructure",
    });

    expect(relevance.relevant).toBe(true);
    expect(relevance.score).toBeGreaterThanOrEqual(0.2);
  });

  it("marks content low relevance when the fetched page is unrelated", () => {
    const relevance = assessContentRelevance({
      title: "Cooking recipes",
      url: "https://example.com/recipes",
      content: "Pasta sauce, soup, and pantry cooking ideas.",
      topic: "AI agent automation web infrastructure",
    });

    expect(relevance.relevant).toBe(false);
  });
});
