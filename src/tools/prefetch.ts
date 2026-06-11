// ABOUTME: prefetch_sources tool — parallel search and browse fan-out for all plan sub-queries.
// ABOUTME: Searches all queries concurrently, then browses top results with a concurrency cap and budget limit.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { multiEngineSearch, filterByRelevance, filterLookupResults } from "../steel-client.js";
import { browseOne, type BrowseOneResult } from "./browse.js";
import type { ToolProgress } from "../event-bus.js";
import type { UrlExcerptStore } from "../url-excerpts.js";
import type { TaskMode } from "../types.js";
import { hasVisitedUrl, normalizeUrlForDedup } from "../url-normalize.js";

const PrefetchParams = Type.Object({
  queries: Type.Array(Type.String(), {
    description:
      "The sub-queries from plan_research to search and browse in parallel",
  }),
});

/** Maximum concurrent browse operations. Higher = faster but more Steel sessions. */
const MAX_CONCURRENT_BROWSES = 10;

/** Maximum URLs to browse per query. */
const BROWSES_PER_QUERY = 2;

type BrowseResult = {
  query: string;
  url: string;
  title: string;
  summary: string;
  rawLength: number;
};

type QueryResult = {
  query: string;
  searchResultCount: number;
  browseResults: BrowseResult[];
  errors: string[];
};

type PrefetchDeps = {
  search?: typeof multiEngineSearch;
  filterByRelevance?: typeof filterByRelevance;
  browseOne?: (opts: Parameters<typeof browseOne>[0]) => Promise<BrowseOneResult>;
};

/** Simple concurrency limiter using a counter and promise queue. */
function createSemaphore(maxConcurrent: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  return {
    async acquire(): Promise<void> {
      if (running < maxConcurrent) {
        running++;
        return;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      running++;
    },
    release(): void {
      running--;
      const next = queue.shift();
      if (next) next();
    },
  };
}

/** Create a prefetch_sources tool that fans out concurrent search+browse. */
export function createPrefetchTool(
  client: Steel,
  scrapedUrls: Set<string>,
  topic: string,
  maxBudget: number,
  taskId?: string,
  progress?: ToolProgress,
  urlExcerpts?: UrlExcerptStore,
  mode?: TaskMode,
  deps: PrefetchDeps = {},
): AgentTool<typeof PrefetchParams> {
  const report = progress ?? ((text: string) => console.log(text));
  const search = deps.search ?? multiEngineSearch;
  const filterResults = deps.filterByRelevance ?? filterByRelevance;
  const browse = deps.browseOne ?? browseOne;
  return {
    name: "prefetch_sources",
    label: "Prefetch Sources",
    description:
      "Search and browse multiple queries in parallel. Pass the sub-queries from plan_research to gather initial results concurrently. This is much faster than sequential search+browse cycles.",
    parameters: PrefetchParams,
    execute: async (_toolCallId, params) => {
      const { queries } = params;
      const semaphore = createSemaphore(MAX_CONCURRENT_BROWSES);

      // Track budget across all queries
      let totalBrowsed = 0;
      let totalQueued = 0;
      const allBrowsedUrls: string[] = [];
      const meaningfulBrowsedUrls: string[] = [];
      const browsingUrls = new Set<string>();
      const queryResults: QueryResult[] = [];
      const browsePromises: Promise<void>[] = [];

      // Helper: queue a browse for a URL within a query result
      function queueBrowse(qr: QueryResult, query: string, url: string) {
        browsePromises.push(
          (async () => {
            await semaphore.acquire();
            try {
              if (totalBrowsed >= maxBudget) return;

              const result = await browse({
                client,
                url,
                topic,
                scrapedUrls,
                taskId,
                urlExcerpts,
              });

              totalBrowsed++;
              report(`    [${totalBrowsed}/${totalQueued}] ${result.fromCache ? "Cached" : "Browsed"}: ${result.title.slice(0, 60)}`);

              if (!result.meaningful) {
                allBrowsedUrls.push(url);
                qr.browseResults.push({
                  query,
                  url,
                  title: result.title,
                  summary: "[Insufficient content]",
                  rawLength: Number(result.details.rawLength ?? 0),
                });
                return;
              }

              allBrowsedUrls.push(url);
              meaningfulBrowsedUrls.push(url);
              const contentRelevant = result.details.contentRelevant !== false;
              const relevancePrefix = contentRelevant
                ? ""
                : "[Low content relevance to the research topic]\n\n";
              qr.browseResults.push({
                query,
                url,
                title: result.title,
                summary: `${relevancePrefix}${String(result.details.summary ?? "")}`,
                rawLength: Number(result.details.rawLength ?? 0),
              });
            } catch (err) {
              qr.errors.push(`Browse failed for ${url}: ${(err as Error).message}`);
            } finally {
              semaphore.release();
            }
          })(),
        );
      }

      // Pipelined: each search immediately queues browses on completion
      report(`    Searching ${queries.length} queries in parallel (pipelined browse)...`);
      await Promise.allSettled(
        queries.map(async (query) => {
          const qr: QueryResult = { query, searchResultCount: 0, browseResults: [], errors: [] };
          queryResults.push(qr);

          try {
            const rawResults = await search(client, query);
            const results = mode === "lookup"
              ? filterLookupResults(rawResults, query, topic)
              : filterResults(rawResults, topic, 0.3, query);
            qr.searchResultCount = results.length;
            report(`    ✓ "${query.slice(0, 50)}" → ${results.length}/${rawResults.length} relevant`);

            let queuedForQuery = 0;
            for (const result of results) {
              if (queuedForQuery >= BROWSES_PER_QUERY) break;
              if (totalQueued >= maxBudget) break;
              const dedupUrl = normalizeUrlForDedup(result.url);
              if (hasVisitedUrl(scrapedUrls, result.url) || browsingUrls.has(dedupUrl)) continue;

              browsingUrls.add(dedupUrl);
              totalQueued++;
              queuedForQuery++;
              queueBrowse(qr, query, result.url);
            }
          } catch (err) {
            qr.errors.push(`Search failed: ${(err as Error).message}`);
          }
        }),
      );

      // Wait for all browse operations (some started during search phase)
      await Promise.allSettled(browsePromises);
      report(`    Prefetch complete: ${totalBrowsed} pages browsed across ${queries.length} queries`);
      if (totalBrowsed === 0) {
        report("    No high-confidence search hits were browsed; switch to direct known-source retrieval or a different search angle.");
      }

      // Format results as structured markdown
      const sections: string[] = [
        `# Prefetch Results`,
        ``,
        `Searched ${queries.length} queries, browsed ${totalBrowsed} pages.`,
        ``,
      ];
      if (totalBrowsed === 0) {
        sections.push(
          `No high-confidence search hits were browsed. Use direct known-source retrieval (official pages, papers, filings, docs) or a substantially different search angle instead of retrying minor query variations.`,
          ``,
        );
      }

      for (const qr of queryResults) {
        sections.push(`## Query: "${qr.query}"`);
        sections.push(
          `Found ${qr.searchResultCount} search results, browsed ${qr.browseResults.length}.`,
        );

        if (qr.errors.length > 0) {
          sections.push(`\n**Errors:** ${qr.errors.join("; ")}`);
        }

        for (const br of qr.browseResults) {
          sections.push(``);
          sections.push(`### ${br.title}`);
          sections.push(`**Source:** ${br.url}`);
          sections.push(`**Raw length:** ${br.rawLength} chars`);
          sections.push(``);
          sections.push(br.summary);
        }

        sections.push(``);
      }

      sections.push(
        `---`,
        `Review these results, record atomic claims with verbatim evidence, then do targeted follow-up searches for any gaps.`,
      );

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
        details: {
          searchedQueries: queries.length,
          browsedCount: totalBrowsed,
          browsedUrls: allBrowsedUrls,
          meaningfulBrowsedUrls,
          queryResults: queryResults.map((qr) => ({
            query: qr.query,
            searchResultCount: qr.searchResultCount,
            browseCount: qr.browseResults.length,
            errorCount: qr.errors.length,
          })),
        },
      };
    },
  };
}
