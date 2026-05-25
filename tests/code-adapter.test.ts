// ABOUTME: Tests for the monty-backed AdapterRuntime — verifies host functions are routed correctly.
// ABOUTME: Uses a stub http_get so tests stay offline and deterministic.

import { describe, it, expect, vi } from "vitest";
import { MontyRuntime, type HttpResponse } from "../src/code-adapter.js";

const EDGAR_ADAPTER_PY = `
import json

params = "q=" + query
if forms:
    params += "&forms=" + ",".join(forms)

resp = http_get(
    "https://efts.sec.gov/LATEST/search-index?" + params,
    {"User-Agent": "durable-researcher", "Accept": "application/json"},
)

results = []
if resp["status"] == 200:
    data = json.loads(resp["body_text"])
    hits = data.get("hits", {}).get("hits", [])
    for hit in hits:
        src = hit.get("_source", {})
        ciks = src.get("ciks") or []
        cik = ciks[0] if ciks else None
        accession = src.get("adsh") or hit.get("_id")
        if not cik or not accession:
            continue
        padded = cik.lstrip("0").zfill(10)
        no_dashes = accession.replace("-", "")
        url = (
            "https://www.sec.gov/Archives/edgar/data/"
            + str(int(padded)) + "/" + no_dashes + "/"
            + accession + "-index.htm"
        )
        names = src.get("display_names") or ["Unknown"]
        company = names[0]
        form = src.get("file_type") or "filing"
        filed = src.get("file_date", "")
        title = company + " - " + form
        if filed:
            title = title + " (filed " + filed + ")"
        snippet_str = "EDGAR filing: " + form
        if filed:
            snippet_str = snippet_str + ", " + filed
        snippet_str = snippet_str + " - " + company
        results.append({"title": title, "url": url, "snippet": snippet_str})

results
`;

describe("MontyRuntime", () => {
  it("routes http_get through host functions and parses EDGAR-shaped JSON", async () => {
    const fakeBody = JSON.stringify({
      hits: {
        hits: [
          {
            _id: "0001628280-25-001234",
            _source: {
              display_names: ["TESLA, INC."],
              file_type: "10-K",
              file_date: "2025-01-30",
              adsh: "0001628280-25-001234",
              ciks: ["0001318605"],
              forms: ["10-K"],
            },
          },
        ],
      },
    });

    const http_get = vi.fn(async (url: string): Promise<HttpResponse> => {
      expect(url).toContain("efts.sec.gov/LATEST/search-index");
      expect(url).toContain("forms=10-K");
      return { status: 200, headers: {}, body_text: fakeBody };
    });

    const runtime = new MontyRuntime();
    const result = (await runtime.run(
      EDGAR_ADAPTER_PY,
      { query: "tesla annual report", forms: ["10-K"] },
      { http_get },
    )) as Array<{ title: string; url: string; snippet: string }>;

    expect(http_get).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe(
      "TESLA, INC. - 10-K (filed 2025-01-30)",
    );
    expect(result[0].url).toBe(
      "https://www.sec.gov/Archives/edgar/data/1318605/000162828025001234/0001628280-25-001234-index.htm",
    );
    expect(result[0].snippet).toContain("EDGAR filing: 10-K");
  });

  it("returns an empty list when http_get reports a non-200 status", async () => {
    const http_get = vi.fn(async (): Promise<HttpResponse> => ({
      status: 429,
      headers: {},
      body_text: "Too Many Requests",
    }));

    const runtime = new MontyRuntime();
    const result = await runtime.run(
      EDGAR_ADAPTER_PY,
      { query: "anything", forms: [] },
      { http_get },
    );

    expect(result).toEqual([]);
  });
});
