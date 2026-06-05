// ABOUTME: Tests canonical URL keys for source deduplication.
// ABOUTME: Ensures visited-source tracking stores raw URLs while comparing normalized variants.

import { describe, expect, it } from "vitest";
import { addVisitedUrl, hasVisitedUrl, normalizeUrlForDedup } from "../src/url-normalize.js";

describe("normalizeUrlForDedup", () => {
  it("normalizes www, host casing, trailing slash, fragments, and tracking params", () => {
    expect(
      normalizeUrlForDedup("HTTPS://www.Example.com/Path/?utm_source=x&b=2&a=1#frag"),
    ).toBe("https://example.com/Path?a=1&b=2");
  });

  it("stores the first raw URL but matches normalized variants", () => {
    const visited = new Set<string>();
    addVisitedUrl(visited, "https://www.example.com/path/?utm_campaign=x");
    addVisitedUrl(visited, "https://example.com/path");

    expect([...visited]).toEqual(["https://www.example.com/path/?utm_campaign=x"]);
    expect(hasVisitedUrl(visited, "https://example.com/path/")).toBe(true);
  });
});
