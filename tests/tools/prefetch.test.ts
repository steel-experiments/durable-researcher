// ABOUTME: Tests for the prefetch_sources tool — parallel search and browse fan-out.
// ABOUTME: Verifies concurrency, budget caps, URL dedup, and individual failure handling.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchResult } from "../../src/types.js";

// Mock the LLM summarization used internally by prefetch
vi.mock("@mariozechner/pi-ai", () => ({
  Type: {
    Object: (s: any) => s,
    Array: (s: any, opts: any) => ({ ...s, ...opts }),
    String: (opts: any) => opts ?? {},
    Number: (opts: any) => opts ?? {},
    Literal: (value: any) => ({ const: value }),
    Union: (schemas: any[], opts: any) => ({ anyOf: schemas, ...opts }),
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
import Steel from "steel-sdk";
import type { Mock } from "vitest";

const mockSearch = vi.fn() as unknown as Mock;
const mockBrowse = vi.fn() as unknown as Mock;
const mockFilterByRelevance = vi.fn((results: SearchResult[]) => results) as unknown as Mock;

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

  function makeTool(
    topic = "test topic",
    maxBudget = 10,
    progress?: (line: string) => void,
    mode?: "lookup" | "extraction" | "survey" | "synthesis",
  ) {
    return createPrefetchTool(
      client,
      scrapedUrls,
      topic,
      maxBudget,
      undefined,
      progress,
      undefined,
      mode,
      {
        search: mockSearch,
        filterByRelevance: mockFilterByRelevance,
        browseOne: mockBrowse,
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    client = {} as Steel;
    scrapedUrls = new Set();
    mockFilterByRelevance.mockImplementation((results: SearchResult[]) => results);

    // Default: search returns 3 results, scrape returns content
    mockSearch.mockImplementation(async (_client, query) => {
      return makeSearchResults(3, query);
    });

    mockBrowse.mockImplementation(async ({ url, scrapedUrls }: { url: string; scrapedUrls: Set<string> }) => {
      scrapedUrls.add(url);
      return {
        text: `## Page at ${url}`,
        title: `Page at ${url}`,
        meaningful: true,
        fromCache: false,
        details: {
          summary: `Content from ${url} ${Array.from({ length: 60 }, (_, i) => `distinct${i}`).join(" ")}`,
          rawLength: 5000,
        },
      };
    });
  });

  it("searches all queries concurrently", async () => {
    const tool = makeTool();

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

    const tool = makeTool("test topic", 20);

    await tool.execute("call-1", {
      queries: ["query A", "query B"],
    });

    // 2 queries × 2 browses each = 4 total
    expect(mockBrowse).toHaveBeenCalledTimes(4);
  });

  it("respects maxBudget cap", async () => {
    const tool = makeTool("test topic", 3);

    await tool.execute("call-1", {
      queries: ["query A", "query B", "query C"],
    });

    // Budget is 3 — should not browse more than 3 URLs total
    expect(mockBrowse.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("adds browsed URLs to scrapedUrls set", async () => {
    const tool = makeTool();

    await tool.execute("call-1", {
      queries: ["query A"],
    });

    // Should have added URLs from browsing
    expect(scrapedUrls.size).toBeGreaterThan(0);
  });

  it("skips already-scraped URLs", async () => {
    scrapedUrls.add("https://query-a-0.com/page");

    const tool = makeTool();

    await tool.execute("call-1", {
      queries: ["query A"],
    });

    // First result was already scraped, so should browse results 1 and 2 instead
    const scrapedArgs = mockBrowse.mock.calls.map((c) => c[0].url);
    expect(scrapedArgs).not.toContain("https://query-a-0.com/page");
  });

  it("handles individual browse failures gracefully", async () => {
    mockBrowse
      .mockResolvedValueOnce({
        text: "Good content here for testing with enough words",
        title: "Good Page",
        meaningful: true,
        fromCache: false,
        details: { summary: "Good content here for testing with enough words", rawLength: 5000 },
      })
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        text: "Another good page content here for testing",
        title: "Another Good Page",
        meaningful: true,
        fromCache: false,
        details: { summary: "Another good page content here for testing", rawLength: 3000 },
      });

    const tool = makeTool();

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

    const tool = makeTool();

    // Should not throw
    const result = await tool.execute("call-1", {
      queries: ["query A", "query B"],
    });

    // Should still have results from the successful query
    expect(result.content[0].text).toContain("query A");
  });

  it("returns structured markdown with per-query sections", async () => {
    const tool = makeTool();

    const result = await tool.execute("call-1", {
      queries: ["quantum computing", "error correction"],
    });

    const text = result.content[0].text;
    expect(text).toContain("quantum computing");
    expect(text).toContain("error correction");
  });

  it("reports browsed URL count in details", async () => {
    const tool = makeTool();

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
    const tool = makeTool("test topic", 10, (line) => progress.push(line));

    const result = await tool.execute("call-1", {
      queries: ["query A"],
    });

    expect(result.details.browsedCount).toBe(0);
    expect(result.content[0].text).toContain("direct known-source retrieval");
    expect(progress.join("\n")).toContain("direct known-source retrieval");
  });

  it("trusts decoded lookup queries instead of re-gating them against the literal topic", async () => {
    mockSearch.mockResolvedValue([
      {
        title: "Bubble Shooter - Play the game for free",
        url: "https://games.example/bubble-shooter",
        snippet: "Play online",
      },
      {
        title: "GREAT Definition & Meaning",
        url: "https://dictionary.example/great",
        snippet: "Dictionary definition",
      },
      {
        title: "Run Forrest Run 5K Bubba Gump Shrimp Co.",
        url: "https://results.example/run-forrest-run-5k",
        snippet: "Great America Santa Clara race results",
      },
    ]);
    mockFilterByRelevance.mockReturnValue([]);

    const tool = makeTool('"bubble gum" 5K Great America', 10, undefined, "lookup");

    const result = await tool.execute("call-1", {
      queries: ["Bubba Gump Run Forrest Run 5K Great America"],
    });

    expect(result.details.browsedCount).toBe(1);
    expect(mockBrowse).toHaveBeenCalledTimes(1);
    expect(mockBrowse).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        url: "https://results.example/run-forrest-run-5k",
      }),
    );
    expect(mockFilterByRelevance).not.toHaveBeenCalled();
  });

  it("deduplicates URLs across queries", async () => {
    const sharedResults: SearchResult[] = [
      { title: "Shared test topic research Page", url: "https://www.shared.com/page/?utm_source=one", snippet: "About test topic research" },
      { title: "Unique test topic research A", url: "https://unique-a.com/page", snippet: "More test topic research" },
    ];
    const duplicateResults: SearchResult[] = [
      { title: "Shared test topic research Page", url: "https://shared.com/page", snippet: "About test topic research" },
      { title: "Unique test topic research A", url: "https://unique-a.com/page", snippet: "More test topic research" },
    ];

    mockSearch.mockResolvedValueOnce(sharedResults).mockResolvedValueOnce(duplicateResults);

    const tool = makeTool();

    await tool.execute("call-1", {
      queries: ["query A", "query B"],
    });

    const scrapedArgUrls = mockBrowse.mock.calls.map((c) => c[0].url);
    const sharedCount = scrapedArgUrls.filter((u) => u.includes("shared.com/page")).length;
    expect(sharedCount).toBeLessThanOrEqual(1);
  });
});
