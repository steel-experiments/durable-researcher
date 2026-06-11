// ABOUTME: Tests for scout's combined search+browse path.
// ABOUTME: Locks lookup-mode decoded queries so exact-answer needles are not filtered out.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchResult } from "../../src/types.js";

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

vi.mock("../../src/prompts.js", () => ({
  loadTemplate: vi.fn().mockResolvedValue("mock system prompt"),
}));

import { searchAndBrowse } from "../../src/tools/scout.js";
import Steel from "steel-sdk";
import type { Mock } from "vitest";

const mockSearch = vi.fn() as unknown as Mock;
const mockBrowse = vi.fn() as unknown as Mock;
const mockFilterByRelevance = vi.fn((results: SearchResult[]) => results) as unknown as Mock;

describe("searchAndBrowse", () => {
  let client: Steel;
  let scrapedUrls: Set<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = {} as Steel;
    scrapedUrls = new Set();
    mockFilterByRelevance.mockImplementation((results: SearchResult[]) => results);
    mockBrowse.mockResolvedValue({
      text: "Race result page",
      title: "Run Forrest Run 5K Results",
      meaningful: true,
      fromCache: false,
      details: {
        summary: `Race result page ${Array.from({ length: 60 }, (_, i) => `distinct${i}`).join(" ")}`,
        rawLength: 5000,
      },
    });
  });

  it("trusts decoded lookup queries instead of re-gating them against the literal topic", async () => {
    mockSearch.mockResolvedValue([
      {
        title: "Run Forrest Run 5K Bubba Gump Shrimp Co.",
        url: "https://results.example/run-forrest-run-5k",
        snippet: "Great America Santa Clara race results",
      },
    ]);
    mockFilterByRelevance.mockReturnValue([]);

    const outcome = await searchAndBrowse({
      client,
      query: "Bubba Gump Run Forrest Run 5K Great America",
      topic: '"bubble gum" 5K Great America',
      scrapedUrls,
      maxBrowse: 3,
      report: () => undefined,
      mode: "lookup",
      deps: {
        search: mockSearch,
        filterByRelevance: mockFilterByRelevance,
        browseOne: mockBrowse,
      },
    });

    expect(outcome.browsedCount).toBe(1);
    expect(mockBrowse).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        url: "https://results.example/run-forrest-run-5k",
      }),
    );
    expect(mockFilterByRelevance).not.toHaveBeenCalled();
  });

  it("keeps relevance gating for synthesis searches", async () => {
    mockSearch.mockResolvedValue([
      {
        title: "Run Forrest Run 5K Bubba Gump Shrimp Co.",
        url: "https://results.example/run-forrest-run-5k",
        snippet: "Great America Santa Clara race results",
      },
    ]);
    mockFilterByRelevance.mockReturnValue([]);

    const outcome = await searchAndBrowse({
      client,
      query: "Bubba Gump Run Forrest Run 5K Great America",
      topic: '"bubble gum" 5K Great America',
      scrapedUrls,
      maxBrowse: 3,
      report: () => undefined,
      mode: "synthesis",
      deps: {
        search: mockSearch,
        filterByRelevance: mockFilterByRelevance,
        browseOne: mockBrowse,
      },
    });

    expect(outcome.browsedCount).toBe(0);
    expect(mockFilterByRelevance).toHaveBeenCalled();
  });

  it("counts meaningful browses separately so junk-only scouts are detectable", async () => {
    mockSearch.mockResolvedValue([
      {
        title: "Bubble Shooter — play online",
        url: "https://games.example/bubble-shooter",
        snippet: "Play bubble shooter free",
      },
    ]);
    mockBrowse.mockResolvedValue({
      text: "",
      title: "Just a moment...",
      meaningful: false,
      fromCache: false,
      details: { rawLength: 120 },
    });

    const outcome = await searchAndBrowse({
      client,
      query: "bubble gum 5k race",
      topic: '"bubble gum" 5K Great America',
      scrapedUrls,
      maxBrowse: 3,
      report: () => undefined,
      deps: {
        search: mockSearch,
        filterByRelevance: mockFilterByRelevance,
        browseOne: mockBrowse,
      },
    });

    expect(outcome.browsedCount).toBe(1);
    expect(outcome.meaningfulCount).toBe(0);
  });

  it("reports meaningfulCount equal to browsedCount when every page has content", async () => {
    mockSearch.mockResolvedValue([
      {
        title: "Run Forrest Run 5K Bubba Gump Shrimp Co.",
        url: "https://results.example/run-forrest-run-5k",
        snippet: "Great America Santa Clara race results",
      },
    ]);

    const outcome = await searchAndBrowse({
      client,
      query: "Run Forrest Run 5K results",
      topic: '"bubble gum" 5K Great America',
      scrapedUrls,
      maxBrowse: 3,
      report: () => undefined,
      deps: {
        search: mockSearch,
        filterByRelevance: mockFilterByRelevance,
        browseOne: mockBrowse,
      },
    });

    expect(outcome.browsedCount).toBe(1);
    expect(outcome.meaningfulCount).toBe(1);
  });
});
