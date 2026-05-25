// ABOUTME: EDGAR search adapter — thin wrapper that runs the blessed src/adapters/edgar.py
// ABOUTME: in a monty sandbox. The Python source is the canonical implementation.

import { MontyRuntime, loadAdapter, type HostFunctions } from "./code-adapter.js";
import type { SearchResult } from "./types.js";

const RUNTIME = new MontyRuntime();
const EDGAR_PY = loadAdapter("edgar");

/** Query EDGAR full-text search and return results in SearchResult format. */
export async function searchEdgar(
  query: string,
  opts: {
    limit?: number;
    /** Restrict to specific form types, e.g. ["10-K", "10-Q"]. */
    forms?: string[];
    /** Override http_get for tests. */
    httpGet?: HostFunctions["http_get"];
  } = {},
): Promise<SearchResult[]> {
  try {
    const results = await RUNTIME.run<
      { query: string; forms: string[]; limit: number },
      SearchResult[]
    >(
      EDGAR_PY,
      {
        query,
        forms: opts.forms ?? [],
        limit: opts.limit ?? 10,
      },
      opts.httpGet ? { http_get: opts.httpGet } : {},
    );
    return results ?? [];
  } catch {
    return [];
  }
}
