// ABOUTME: prefetch_sources tool — parallel search and browse fan-out for all plan sub-queries.
// ABOUTME: Searches all queries concurrently, then browses top results with a concurrency cap and budget limit.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { multiEngineSearch, scrapeUrl } from "../steel-client.js";
import { isContentMeaningful, truncateContent } from "../content.js";
import { summarizeContent } from "./browse.js";

const PrefetchParams = Type.Object({
  queries: Type.Array(Type.String(), {
    description:
      "The sub-queries from plan_research to search and browse in parallel",
  }),
});

/** Maximum concurrent browse operations to avoid overwhelming Steel/LLM APIs. */
const MAX_CONCURRENT_BROWSES = 5;

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
): AgentTool<typeof PrefetchParams> {
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
      // Track URLs being browsed across queries to avoid duplicates
      const browsingUrls = new Set<string>();

      // Phase 1: Search all queries concurrently
      console.log(`    Searching ${queries.length} queries in parallel...`);
      const searchResults = await Promise.allSettled(
        queries.map(async (query) => {
          const results = await multiEngineSearch(client, query);
          console.log(`    ✓ "${query.slice(0, 50)}" → ${results.length} results`);
          return { query, results };
        }),
      );
      const successCount = searchResults.filter((r) => r.status === "fulfilled").length;
      console.log(`    Searches complete: ${successCount}/${queries.length} succeeded, browsing top results...`);

      // Phase 2: For each successful search, browse top URLs concurrently
      const queryResults: QueryResult[] = [];

      const browsePromises: Promise<void>[] = [];

      for (let idx = 0; idx < searchResults.length; idx++) {
        const searchResult = searchResults[idx];
        if (searchResult.status === "rejected") {
          const query = queries[idx];
          queryResults.push({
            query,
            searchResultCount: 0,
            browseResults: [],
            errors: [`Search failed: ${searchResult.reason?.message ?? "unknown error"}`],
          });
          continue;
        }

        const { query, results } = searchResult.value;
        const qr: QueryResult = {
          query,
          searchResultCount: results.length,
          browseResults: [],
          errors: [],
        };
        queryResults.push(qr);

        // Pick top URLs that haven't been scraped or queued yet
        const urlsToBrowse: { url: string; title: string }[] = [];
        for (const result of results) {
          if (urlsToBrowse.length >= BROWSES_PER_QUERY) break;
          if (totalQueued >= maxBudget) break;
          if (scrapedUrls.has(result.url)) continue;
          if (browsingUrls.has(result.url)) continue;

          urlsToBrowse.push({ url: result.url, title: result.title });
          browsingUrls.add(result.url);
          totalQueued++;
        }

        // Browse each URL with concurrency control
        for (const { url, title } of urlsToBrowse) {
          browsePromises.push(
            (async () => {
              await semaphore.acquire();
              try {
                if (totalBrowsed >= maxBudget) return;

                const scraped = await scrapeUrl(client, url);
                scrapedUrls.add(url);
                totalBrowsed++;
                allBrowsedUrls.push(url);
                console.log(`    [${totalBrowsed}/${totalQueued}] Browsed: ${scraped.title.slice(0, 60)}`);

                if (!isContentMeaningful(scraped.content)) {
                  qr.browseResults.push({
                    query,
                    url,
                    title: scraped.title,
                    summary: "[Insufficient content]",
                    rawLength: scraped.rawLength,
                  });
                  return;
                }

                let summary: string;
                try {
                  summary = await summarizeContent(scraped.content, topic);
                } catch {
                  summary = truncateContent(scraped.content, 2000);
                }

                qr.browseResults.push({
                  query,
                  url,
                  title: scraped.title,
                  summary,
                  rawLength: scraped.rawLength,
                });
              } catch (err) {
                qr.errors.push(
                  `Browse failed for ${url}: ${(err as Error).message}`,
                );
              } finally {
                semaphore.release();
              }
            })(),
          );
        }
      }

      // Wait for all browse operations to complete
      await Promise.allSettled(browsePromises);
      console.log(`    Prefetch complete: ${totalBrowsed} pages browsed across ${queries.length} queries`);

      // Format results as structured markdown
      const sections: string[] = [
        `# Prefetch Results`,
        ``,
        `Searched ${queries.length} queries, browsed ${totalBrowsed} pages.`,
        ``,
      ];

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
        `Review these results, take notes on key findings, then do targeted follow-up searches for any gaps.`,
      );

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
        details: {
          searchedQueries: queries.length,
          browsedCount: totalBrowsed,
          browsedUrls: allBrowsedUrls,
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
