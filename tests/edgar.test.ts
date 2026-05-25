// ABOUTME: Integration tests for searchEdgar — runs the blessed src/adapters/edgar.py against a
// ABOUTME: stubbed http_get. Verifies URL shape, parsing, limit, and error paths.

import { describe, it, expect, vi } from "vitest";
import { searchEdgar } from "../src/edgar.js";
import type { HttpResponse } from "../src/code-adapter.js";

function makeFakeHttpGet(
  bodyFactory: (url: string) => { status: number; body: unknown } | { status: number; body_text: string },
) {
  return vi.fn(async (url: string): Promise<HttpResponse> => {
    const r = bodyFactory(url);
    const body_text =
      "body_text" in r ? r.body_text : JSON.stringify(r.body);
    return { status: r.status, headers: {}, body_text };
  });
}

describe("searchEdgar", () => {
  it("hits efts.sec.gov with the URL-encoded query", async () => {
    const httpGet = makeFakeHttpGet(() => ({
      status: 200,
      body: { hits: { hits: [] } },
    }));
    await searchEdgar("Apple revenue", { httpGet });
    const calledUrl = httpGet.mock.calls[0][0];
    expect(calledUrl).toContain("efts.sec.gov/LATEST/search-index");
    expect(calledUrl).toContain("q=Apple+revenue");
  });

  it("passes form filters as a URL-encoded comma list", async () => {
    const httpGet = makeFakeHttpGet(() => ({
      status: 200,
      body: { hits: { hits: [] } },
    }));
    await searchEdgar("Apple", { forms: ["10-K", "10-Q"], httpGet });
    const calledUrl = httpGet.mock.calls[0][0];
    expect(calledUrl).toContain("forms=10-K%2C10-Q");
  });

  it("parses a typical EDGAR full-text search response", async () => {
    const httpGet = makeFakeHttpGet(() => ({
      status: 200,
      body: {
        hits: {
          hits: [
            {
              _id: "0000320193-25-000001",
              _source: {
                display_names: ["Apple Inc.  (AAPL)"],
                file_type: "10-K",
                file_date: "2025-11-01",
                adsh: "0000320193-25-000001",
                ciks: ["0000320193"],
              },
            },
          ],
        },
      },
    }));
    const results = await searchEdgar("Apple", { httpGet });
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("Apple");
    expect(results[0].title).toContain("10-K");
    expect(results[0].url).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/0000320193-25-000001-index.htm",
    );
    expect(results[0].snippet.toLowerCase()).toContain("filing");
  });

  it("respects the limit parameter", async () => {
    const httpGet = makeFakeHttpGet(() => ({
      status: 200,
      body: {
        hits: {
          hits: Array.from({ length: 5 }, (_, i) => ({
            _id: `0000000000-25-00000${i}`,
            _source: {
              display_names: [`Company ${i}`],
              file_type: "10-K",
              adsh: `0000000000-25-00000${i}`,
              ciks: ["0000000123"],
            },
          })),
        },
      },
    }));
    const results = await searchEdgar("anything", { limit: 2, httpGet });
    expect(results).toHaveLength(2);
  });

  it("skips hits with missing CIK or accession", async () => {
    const httpGet = makeFakeHttpGet(() => ({
      status: 200,
      body: {
        hits: {
          hits: [
            { _id: "x", _source: { display_names: ["A"], file_type: "10-K" } },
            {
              _source: {
                display_names: ["B"],
                file_type: "10-Q",
                adsh: "0000-25-001",
                ciks: ["123"],
              },
            },
          ],
        },
      },
    }));
    const results = await searchEdgar("x", { httpGet });
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("B");
  });

  it("returns an empty array on non-200 responses", async () => {
    const httpGet = makeFakeHttpGet(() => ({
      status: 429,
      body_text: "rate limited",
    }));
    const results = await searchEdgar("anything", { httpGet });
    expect(results).toEqual([]);
  });

  it("returns an empty array if http_get throws", async () => {
    const httpGet = vi.fn(async () => {
      throw new Error("network down");
    });
    const results = await searchEdgar("anything", { httpGet });
    expect(results).toEqual([]);
  });
});
