// ABOUTME: EDGAR (SEC) full-text search adapter — queries efts.sec.gov and returns SearchResult[].
// ABOUTME: Use this when the topic asks for primary financial filings (10-K, 10-Q, 8-K, etc.).

import type { SearchResult } from "./types.js";

const EDGAR_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_FETCH_TIMEOUT_MS = 15_000;

/** Raw shape of a single hit from the EDGAR full-text search API. */
type EdgarHit = {
  _id?: string;
  _source?: {
    display_names?: string[];
    file_type?: string;
    file_date?: string;
    adsh?: string;
    ciks?: string[];
    forms?: string[];
  };
};

type EdgarResponse = {
  hits?: {
    hits?: EdgarHit[];
  };
};

/** Build the public URL to an EDGAR filing index page from CIK + accession number. */
export function buildFilingUrl(cik: string, accession: string): string {
  // EDGAR pads CIKs to 10 digits in URLs.
  const paddedCik = cik.replace(/^0+/, "").padStart(10, "0");
  // Accession format in API: "0000000000-00-000000" → URL path uses the no-dash form.
  const noDashes = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(paddedCik)}/${noDashes}/${accession}-index.htm`;
}

/** Convert a raw EDGAR API response into our SearchResult shape. */
export function parseEdgarResponse(
  body: unknown,
  limit = 10,
): SearchResult[] {
  const response = body as EdgarResponse;
  const hits = response?.hits?.hits ?? [];
  const results: SearchResult[] = [];

  for (const hit of hits) {
    const source = hit._source;
    if (!source) continue;
    const company = source.display_names?.[0] ?? "Unknown filer";
    const form = source.file_type ?? source.forms?.[0] ?? "filing";
    const filed = source.file_date ?? "";
    const cik = source.ciks?.[0];
    const accession = source.adsh ?? hit._id;
    if (!cik || !accession) continue;

    const url = buildFilingUrl(cik, accession);
    const title = filed
      ? `${company} — ${form} (filed ${filed})`
      : `${company} — ${form}`;
    results.push({
      title,
      url,
      snippet: `EDGAR filing: ${form}${filed ? `, ${filed}` : ""} — ${company}`,
    });
    if (results.length >= limit) break;
  }

  return results;
}

/** Query EDGAR full-text search and return results in SearchResult format. */
export async function searchEdgar(
  query: string,
  opts: {
    limit?: number;
    /** Restrict to specific form types, e.g. ["10-K", "10-Q"]. */
    forms?: string[];
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SearchResult[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ q: query });
  if (opts.forms?.length) params.set("forms", opts.forms.join(","));

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timerId = setTimeout(() => controller.abort(), EDGAR_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${EDGAR_SEARCH_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        // SEC requests a descriptive User-Agent for all programmatic access.
        "User-Agent": "durable-researcher (research-agent@steelbrowser.com)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body = await response.json();
    return parseEdgarResponse(body, opts.limit ?? 10);
  } catch {
    return [];
  } finally {
    clearTimeout(timerId);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}
