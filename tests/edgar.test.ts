// ABOUTME: Tests for EDGAR adapter — pure parser + searchEdgar with stubbed fetch.
// ABOUTME: No live SEC API calls.

import { describe, it, expect } from "vitest";
import { parseEdgarResponse, buildFilingUrl, searchEdgar } from "../src/edgar.js";

describe("buildFilingUrl", () => {
  it("zero-pads CIK and strips dashes from accession in the path", () => {
    const url = buildFilingUrl("320193", "0000320193-25-000001");
    expect(url).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/0000320193-25-000001-index.htm",
    );
  });

  it("handles already-padded CIKs", () => {
    const url = buildFilingUrl("0000320193", "0000320193-25-000099");
    expect(url).toContain("/data/320193/");
  });
});

describe("parseEdgarResponse", () => {
  it("returns empty array for missing/empty hits", () => {
    expect(parseEdgarResponse(null)).toEqual([]);
    expect(parseEdgarResponse({})).toEqual([]);
    expect(parseEdgarResponse({ hits: { hits: [] } })).toEqual([]);
  });

  it("parses a typical EDGAR full-text search response", () => {
    const body = {
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
    };
    const results = parseEdgarResponse(body);
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("Apple");
    expect(results[0].title).toContain("10-K");
    expect(results[0].url).toContain("sec.gov");
    expect(results[0].snippet.toLowerCase()).toContain("filing");
  });

  it("respects the limit parameter", () => {
    const body = {
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
    };
    const results = parseEdgarResponse(body, 2);
    expect(results).toHaveLength(2);
  });

  it("skips hits with missing CIK or accession", () => {
    const body = {
      hits: {
        hits: [
          { _id: "x", _source: { display_names: ["A"], file_type: "10-K" } }, // no CIK
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
    };
    const results = parseEdgarResponse(body);
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("B");
  });
});

describe("searchEdgar", () => {
  it("calls the EDGAR search endpoint with the query and returns parsed hits", async () => {
    let calledUrl: string | undefined;
    const fakeFetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({
          hits: {
            hits: [
              {
                _source: {
                  display_names: ["Test Co"],
                  file_type: "10-K",
                  file_date: "2025-01-01",
                  adsh: "0001234567-25-000001",
                  ciks: ["0001234567"],
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const results = await searchEdgar("Apple revenue", { fetchImpl: fakeFetch });
    expect(calledUrl).toContain("efts.sec.gov");
    expect(calledUrl).toContain("q=Apple+revenue");
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("Test Co");
  });

  it("passes form filters to the API as a comma list", async () => {
    let calledUrl: string | undefined;
    const fakeFetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    await searchEdgar("Apple", { forms: ["10-K", "10-Q"], fetchImpl: fakeFetch });
    expect(calledUrl).toContain("forms=10-K%2C10-Q");
  });

  it("returns an empty array on non-200 responses", async () => {
    const fakeFetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const results = await searchEdgar("anything", { fetchImpl: fakeFetch });
    expect(results).toEqual([]);
  });

  it("returns an empty array if fetch throws", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const results = await searchEdgar("anything", { fetchImpl: fakeFetch });
    expect(results).toEqual([]);
  });
});
