// ABOUTME: Tests for the per-URL excerpt store used to ground citation verification.
// ABOUTME: Captures verbatim text from each browsed page so the verifier can fall back to it.

import { describe, it, expect } from "vitest";
import {
  captureExcerptsForUrl,
  createUrlExcerptStore,
  extractExcerptsFromContent,
  parseKeyExcerptsFromSummary,
  rebuildUrlExcerptsFromCache,
} from "../src/url-excerpts.js";

describe("extractExcerptsFromContent", () => {
  it("returns an empty array for empty content", () => {
    expect(extractExcerptsFromContent("")).toEqual([]);
    expect(extractExcerptsFromContent("   \n\n  ")).toEqual([]);
  });

  it("splits paragraphs and trims each", () => {
    const content = "First paragraph here.\n\nSecond para.\n\nThird.";
    const excerpts = extractExcerptsFromContent(content, { maxCount: 5, maxLength: 100, minLength: 1 });
    expect(excerpts).toEqual([
      "First paragraph here.",
      "Second para.",
      "Third.",
    ]);
  });

  it("respects maxCount", () => {
    const content = "A.\n\nB.\n\nC.\n\nD.\n\nE.";
    const excerpts = extractExcerptsFromContent(content, { maxCount: 2, maxLength: 100, minLength: 1 });
    expect(excerpts).toEqual(["A.", "B."]);
  });

  it("truncates excerpts longer than maxLength", () => {
    const long = "x".repeat(500);
    const excerpts = extractExcerptsFromContent(long, { maxCount: 2, maxLength: 100 });
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toHaveLength(100);
  });

  it("skips paragraphs that are too short to be useful (default min length)", () => {
    // Paragraphs shorter than the default minimum should be filtered out
    const content = "Real paragraph with substantial content here.\n\nx\n\nAnother real one with substance also.";
    const excerpts = extractExcerptsFromContent(content);
    expect(excerpts).toEqual([
      "Real paragraph with substantial content here.",
      "Another real one with substance also.",
    ]);
  });

  it("handles a single long block with no paragraph breaks by single-line fallback", () => {
    const content = "Just one long line with content and stuff worth keeping verbatim.";
    const excerpts = extractExcerptsFromContent(content, { maxCount: 4, maxLength: 200 });
    expect(excerpts).toEqual([content]);
  });
});

describe("parseKeyExcerptsFromSummary", () => {
  it("returns empty array when no Key excerpts section is present", () => {
    expect(parseKeyExcerptsFromSummary("Just a plain summary.")).toEqual([]);
  });

  it("parses bullet-style key excerpts", () => {
    const summary = [
      "1. **Summary**",
      "The page says things.",
      "",
      "2. **Key excerpts**",
      '* "First verbatim quote here."',
      '* "Second one — with dashes."',
      '* "Third quote about numbers like 0.143%."',
    ].join("\n");
    const got = parseKeyExcerptsFromSummary(summary);
    expect(got).toEqual([
      "First verbatim quote here.",
      "Second one — with dashes.",
      "Third quote about numbers like 0.143%.",
    ]);
  });

  it("parses dash-prefixed key excerpts", () => {
    const summary = [
      "**Key excerpts**",
      '- "Quote A."',
      '- "Quote B."',
    ].join("\n");
    expect(parseKeyExcerptsFromSummary(summary)).toEqual(["Quote A.", "Quote B."]);
  });

  it("ignores other sections", () => {
    const summary = [
      "**Key excerpts**",
      '* "Important quote."',
      "",
      "**Notes**",
      "* These are not excerpts",
    ].join("\n");
    expect(parseKeyExcerptsFromSummary(summary)).toEqual(["Important quote."]);
  });

  it("trims and de-quotes the excerpt text", () => {
    const summary = [
      "**Key excerpts**",
      '*   "  Padded quote.  "  ',
      "* No quotes here, but content.",
    ].join("\n");
    expect(parseKeyExcerptsFromSummary(summary)).toEqual([
      "Padded quote.",
      "No quotes here, but content.",
    ]);
  });

  it("stops at a single-asterisk follow-up section (not just **bold**)", () => {
    // Some LLMs render section headings with single asterisks. The stop regex
    // must not let bullets in a *Notes* (or similar) section bleed into excerpts.
    const summary = [
      "**Key excerpts**",
      '* "Real verbatim quote."',
      "",
      "*Notes*",
      "* Not a quote — should be excluded",
    ].join("\n");
    expect(parseKeyExcerptsFromSummary(summary)).toEqual([
      "Real verbatim quote.",
    ]);
  });

  it("handles CRLF line endings without leaving trailing \\r in excerpts", () => {
    const summary =
      "**Key excerpts**\r\n* \"First quote.\"\r\n* \"Second quote.\"\r\n";
    const got = parseKeyExcerptsFromSummary(summary);
    expect(got).toEqual(["First quote.", "Second quote."]);
    for (const e of got) {
      expect(e).not.toMatch(/\r/);
    }
  });
});

describe("createUrlExcerptStore", () => {
  it("starts empty", () => {
    const store = createUrlExcerptStore();
    expect(store.get("https://a.com")).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it("stores and retrieves excerpts by URL", () => {
    const store = createUrlExcerptStore();
    store.add("https://a.com", ["e1", "e2"]);
    expect(store.get("https://a.com")).toEqual(["e1", "e2"]);
  });

  it("merges excerpts across multiple add() calls for the same URL", () => {
    const store = createUrlExcerptStore();
    store.add("https://a.com", ["e1", "e2"]);
    store.add("https://a.com", ["e3"]);
    expect(store.get("https://a.com")).toEqual(["e1", "e2", "e3"]);
  });

  it("dedupes excerpts on merge (case-insensitive, whitespace-normalized)", () => {
    const store = createUrlExcerptStore();
    store.add("https://a.com", ["Same quote."]);
    store.add("https://a.com", [" same QUOTE. ", "New one."]);
    expect(store.get("https://a.com")).toEqual(["Same quote.", "New one."]);
  });

  it("ignores empty or whitespace-only entries", () => {
    const store = createUrlExcerptStore();
    store.add("https://a.com", ["", "   ", "real"]);
    expect(store.get("https://a.com")).toEqual(["real"]);
  });

  it("caps total excerpts per URL", () => {
    const store = createUrlExcerptStore({ maxPerUrl: 3 });
    store.add("https://a.com", ["a", "b", "c", "d", "e"]);
    expect(store.get("https://a.com")).toEqual(["a", "b", "c"]);
  });

  it("asMap exposes a read-only view of all entries", () => {
    const store = createUrlExcerptStore();
    store.add("https://a.com", ["x"]);
    store.add("https://b.com", ["y"]);
    const map = store.asMap();
    expect(map.size).toBe(2);
    expect(map.get("https://a.com")).toEqual(["x"]);
    expect(map.get("https://b.com")).toEqual(["y"]);
  });

  it("ignores empty-URL inputs", () => {
    const store = createUrlExcerptStore();
    store.add("", ["e1"]);
    expect(store.size()).toBe(0);
  });
});

describe("rebuildUrlExcerptsFromCache", () => {
  it("populates the store from cached content for each URL", async () => {
    const store = createUrlExcerptStore();
    const cache = new Map<string, { content: string }>([
      [
        "https://a.com",
        { content: "First paragraph with substance.\n\nSecond paragraph with substance." },
      ],
      ["https://b.com", { content: "B page paragraph with enough length to retain." }],
    ]);
    await rebuildUrlExcerptsFromCache(
      store,
      ["https://a.com", "https://b.com"],
      async (url) => cache.get(url) ?? null,
    );
    expect(store.get("https://a.com").length).toBeGreaterThan(0);
    expect(store.get("https://b.com").length).toBeGreaterThan(0);
  });

  it("skips URLs with no cache entry", async () => {
    const store = createUrlExcerptStore();
    await rebuildUrlExcerptsFromCache(store, ["https://miss.com"], async () => null);
    expect(store.size()).toBe(0);
  });

  it("swallows per-URL cache errors instead of aborting", async () => {
    const store = createUrlExcerptStore();
    await rebuildUrlExcerptsFromCache(
      store,
      ["https://a.com", "https://b.com"],
      async (url) => {
        if (url === "https://a.com") throw new Error("boom");
        return { content: "B page paragraph with enough length to retain." };
      },
    );
    expect(store.get("https://a.com")).toEqual([]);
    expect(store.get("https://b.com").length).toBeGreaterThan(0);
  });
});

describe("captureExcerptsForUrl", () => {
  it("prefers Key excerpts from the summary when present", () => {
    const store = createUrlExcerptStore();
    const summary = [
      "1. **Summary**",
      "Some prose.",
      "",
      "2. **Key excerpts**",
      '* "Verbatim quote A."',
      '* "Verbatim quote B."',
    ].join("\n");
    captureExcerptsForUrl(store, "https://a.com", {
      summary,
      content: "Raw content paragraph one with substance.\n\nRaw paragraph two with substance too.",
    });
    expect(store.get("https://a.com")).toEqual([
      "Verbatim quote A.",
      "Verbatim quote B.",
    ]);
  });

  it("falls back to raw content when the summary has no Key excerpts", () => {
    const store = createUrlExcerptStore();
    captureExcerptsForUrl(store, "https://a.com", {
      summary: "1. **Summary** Just prose. No quotes section.",
      content: "Raw content paragraph one with substance.\n\nRaw paragraph two with substance too.",
    });
    expect(store.get("https://a.com")).toEqual([
      "Raw content paragraph one with substance.",
      "Raw paragraph two with substance too.",
    ]);
  });

  it("no-ops when both summary and content are empty", () => {
    const store = createUrlExcerptStore();
    captureExcerptsForUrl(store, "https://a.com", { summary: "", content: "" });
    expect(store.size()).toBe(0);
  });

  it("no-ops when the store is undefined", () => {
    // Should not throw — used in code paths where the store may be optional.
    expect(() =>
      captureExcerptsForUrl(undefined, "https://a.com", { content: "x" }),
    ).not.toThrow();
  });
});
