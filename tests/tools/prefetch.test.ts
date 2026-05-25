// ABOUTME: Tests for the prefetch_sources tool — parallel search and browse fan-out.
// ABOUTME: Verifies concurrency, budget caps, URL dedup, and individual failure handling.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchResult } from "../../src/types.js";

// We mock the Steel client and LLM calls at the module level
vi.mock("../../src/steel-client.js", () => ({
  multiEngineSearch: vi.fn(),
  scrapeUrl: vi.fn(),
  filterByRelevance: vi.fn((results: any[]) => results),
}));

// Mock the LLM summarization used internally by prefetch
vi.mock("@mariozechner/pi-ai", () => ({
  Type: {
    Object: (s: any) => s,
    Array: (s: any, opts: any) => ({ ...s, ...opts }),
    String: (opts: any) => opts ?? {},
    Number: (opts: any) => opts ?? {},
    Optional: (schema: any) => schema,
  },
  completeSimple: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Mocked summary of the page content." }],
  }),
  getModel: vi.fn().mockReturnValue({ id: "mock-model" }),
  getEnvApiKey: vi.fn().mockReturnValue("mock-key"),
}));

// Mock the template loader
vi.mock("../../src/prompts.js", () => ({
  loadTemplate: vi.fn().mockResolvedValue("mock system prompt"),
}));

import { createPrefetchTool } from "../../src/tools/prefetch.js";
import { multiEngineSearch, scrapeUrl } from "../../src/steel-client.js";
import Steel from "steel-sdk";
import type { Mock } from "vitest";

const mockSearch = multiEngineSearch as unknown as Mock;
const mockScrape = scrapeUrl as unknown as Mock;

function makeSearchResults(count: number, prefix: string): SearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `${prefix} test topic research Result ${i}`,
    url: `https://${prefix.toLowerCase().replace(/\s/g, "-")}-${i}.com/page`,
    snippet: `Snippet about test topic research for ${prefix} result ${i}`,
  }));
}

describe("createPrefetchTool", () => {
  let client: Steel;
  let scrapedUrls: Set<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = {} as Steel;
    scrapedUrls = new Set();

    // Default: search returns 3 results, scrape returns content
    mockSearch.mockImplementation(async (_client, query) => {
      return makeSearchResults(3, query);
    });

    mockScrape.mockImplementation(async (_client, url) => ({
      content: `Content from ${url} with enough words to be meaningful and pass content checks easily for testing purposes`,
      title: `Page at ${url}`,
      rawLength: 5000,
    }));
  });

  it("searches all queries concurrently", async () => {
    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 10);

    await tool.execute("call-1", {
      queries: ["query A", "query B", "query C"],
    });

    expect(mockSearch).toHaveBeenCalledTimes(3);
    expect(mockSearch).toHaveBeenCalledWith(client, "query A");
    expect(mockSearch).toHaveBeenCalledWith(client, "query B");
    expect(mockSearch).toHaveBeenCalledWith(client, "query C");
  });

  it("browses top 2 URLs per query", async () => {
    mockSearch.mockImplementation(async (_client, query) => {
      return makeSearchResults(5, query); // 5 results per query
    });

    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 20);

    await tool.execute("call-1", {
      queries: ["query A", "query B"],
    });

    // 2 queries × 2 browses each = 4 total
    expect(mockScrape).toHaveBeenCalledTimes(4);
  });

  it("respects maxBudget cap", async () => {
    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 3);

    await tool.execute("call-1", {
      queries: ["query A", "query B", "query C"],
    });

    // Budget is 3 — should not browse more than 3 URLs total
    expect(mockScrape.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("adds browsed URLs to scrapedUrls set", async () => {
    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 10);

    await tool.execute("call-1", {
      queries: ["query A"],
    });

    // Should have added URLs from browsing
    expect(scrapedUrls.size).toBeGreaterThan(0);
  });

  it("skips already-scraped URLs", async () => {
    scrapedUrls.add("https://query-a-0.com/page");

    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 10);

    await tool.execute("call-1", {
      queries: ["query A"],
    });

    // First result was already scraped, so should browse results 1 and 2 instead
    const scrapedArgs = mockScrape.mock.calls.map((c) => c[1]);
    expect(scrapedArgs).not.toContain("https://query-a-0.com/page");
  });

  it("handles individual browse failures gracefully", async () => {
    mockScrape
      .mockResolvedValueOnce({
        content: "Good content here for testing with enough words",
        title: "Good Page",
        rawLength: 5000,
      })
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        content: "Another good page content here for testing",
        title: "Another Good Page",
        rawLength: 3000,
      });

    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 10);

    // Should not throw
    const result = await tool.execute("call-1", {
      queries: ["query A", "query B"],
    });

    // Should have results from successful browses
    expect(result.content[0].text).toContain("Good Page");
  });

  it("handles search failures gracefully", async () => {
    mockSearch
      .mockResolvedValueOnce(makeSearchResults(3, "query A"))
      .mockRejectedValueOnce(new Error("Search failed"));

    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 10);

    // Should not throw
    const result = await tool.execute("call-1", {
      queries: ["query A", "query B"],
    });

    // Should still have results from the successful query
    expect(result.content[0].text).toContain("query A");
  });

  it("returns structured markdown with per-query sections", async () => {
    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 10);

    const result = await tool.execute("call-1", {
      queries: ["quantum computing", "error correction"],
    });

    const text = result.content[0].text;
    expect(text).toContain("quantum computing");
    expect(text).toContain("error correction");
  });

  it("reports browsed URL count in details", async () => {
    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 10);

    const result = await tool.execute("call-1", {
      queries: ["query A"],
    });

    expect(result.details).toHaveProperty("browsedCount");
    expect(result.details.browsedCount).toBeGreaterThan(0);
    expect(result.details).toHaveProperty("searchedQueries");
    expect(result.details).toHaveProperty("browsedUrls");
  });

  it("advises direct known-source retrieval when no pages are browsed", async () => {
    mockSearch.mockResolvedValue([]);
    const progress: string[] = [];
    const tool = createPrefetchTool(
      client,
      scrapedUrls,
      "test topic",
      10,
      undefined,
      (line) => progress.push(line),
    );

    const result = await tool.execute("call-1", {
      queries: ["query A"],
    });

    expect(result.details.browsedCount).toBe(0);
    expect(result.content[0].text).toContain("direct known-source retrieval");
    expect(progress.join("\n")).toContain("direct known-source retrieval");
  });

  it("deduplicates URLs across queries", async () => {
    // Both queries return the same URL
    const sharedResults: SearchResult[] = [
      { title: "Shared test topic research Page", url: "https://shared.com/page", snippet: "About test topic research" },
      { title: "Unique test topic research A", url: "https://unique-a.com/page", snippet: "More test topic research" },
    ];

    mockSearch.mockResolvedValue(sharedResults);

    const tool = createPrefetchTool(client, scrapedUrls, "test topic", 10);

    await tool.execute("call-1", {
      queries: ["query A", "query B"],
    });

    // shared.com/page should only be scraped once
    const scrapedArgUrls = mockScrape.mock.calls.map((c) => c[1]);
    const sharedCount = scrapedArgUrls.filter(
      (u) => u === "https://shared.com/page",
    ).length;
    expect(sharedCount).toBeLessThanOrEqual(1);
  });
});
