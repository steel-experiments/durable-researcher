// ABOUTME: scout tool — search a query and browse top results in one call.
// ABOUTME: Saves 1-2 LLM turns per follow-up cycle by combining search + browse into a single tool.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { multiEngineSearch, scrapeUrl, filterByRelevance } from "../steel-client.js";
import { isContentMeaningful, truncateContent } from "../content.js";
import { summarizeContent } from "./browse.js";
import { getCachedBrowse, setCachedBrowse } from "../browse-cache.js";

const ScoutParams = Type.Object({
  query: Type.String({ description: "The search query to execute" }),
  focus: Type.Optional(
    Type.String({
      description: "What to focus on when reading results (guides relevance assessment)",
    }),
  ),
  maxBrowse: Type.Optional(
    Type.Number({
      description: "Maximum pages to browse from results (default: 3)",
    }),
  ),
});

/** Content shorter than this is returned raw — preserves specific data. */
const SMART_SUMMARIZE_THRESHOLD = 4000;

/** Default number of pages to browse per scout call. */
const DEFAULT_MAX_BROWSE = 3;

type ScoutResult = {
  url: string;
  title: string;
  content: string;
  rawLength: number;
};

/** Create a scout tool that searches and browses in one call. */
export function createScoutTool(
  client: Steel,
  scrapedUrls: Set<string>,
  topic: string,
  taskId?: string,
): AgentTool<typeof ScoutParams> {
  return {
    name: "scout",
    label: "Scout",
    description:
      "Search for a query AND browse the top results in one step. Returns search results plus content from the most relevant pages. Faster than sequential search → browse when you need to fill a specific gap.",
    parameters: ScoutParams,
    execute: async (_toolCallId, params) => {
      const maxBrowse = params.maxBrowse ?? DEFAULT_MAX_BROWSE;

      // Search
      const rawResults = await multiEngineSearch(client, params.query);
      const relevant = filterByRelevance(rawResults, topic, 0.2, params.query);
      const fresh = relevant.filter((r) => !scrapedUrls.has(r.url));

      if (fresh.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `Scout: searched "${params.query}" — ${rawResults.length} results found, ${relevant.length} relevant, none new. Try a different query or browse a known URL directly.`,
          }],
          details: { query: params.query, totalResults: rawResults.length, relevantResults: relevant.length, browsedCount: 0, browsedUrls: [] },
        };
      }

      // Browse top results in parallel
      const toBrowse = fresh.slice(0, maxBrowse);
      console.log(`    [SCOUT] "${params.query.slice(0, 50)}" → ${relevant.length}/${rawResults.length} relevant, browsing ${toBrowse.length}...`);

      const browseResults: ScoutResult[] = [];
      const browsedUrls: string[] = [];
      const errors: string[] = [];

      await Promise.allSettled(
        toBrowse.map(async (result) => {
          try {
            let scraped: { content: string; title: string; rawLength: number };

            // Check browse cache
            const cached = taskId ? await getCachedBrowse(taskId, result.url).catch(() => null) : null;
            if (cached) {
              scraped = { content: cached.content, title: cached.title, rawLength: cached.rawLength };
            } else {
              scraped = await scrapeUrl(client, result.url);
              if (taskId) {
                await setCachedBrowse(taskId, result.url, scraped).catch(() => {});
              }
            }

            scrapedUrls.add(result.url);
            browsedUrls.push(result.url);

            if (!isContentMeaningful(scraped.content)) {
              browseResults.push({
                url: result.url,
                title: scraped.title,
                content: "[Insufficient content]",
                rawLength: scraped.rawLength,
              });
              return;
            }

            // Smart summarization: short content raw, long content LLM-summarized
            let processedContent: string;
            if (scraped.content.length <= SMART_SUMMARIZE_THRESHOLD) {
              processedContent = scraped.content;
            } else {
              try {
                processedContent = await summarizeContent(scraped.content, topic, params.focus);
              } catch {
                processedContent = truncateContent(scraped.content, 4000);
              }
            }

            browseResults.push({
              url: result.url,
              title: scraped.title,
              content: processedContent,
              rawLength: scraped.rawLength,
            });

            console.log(`    [SCOUT] ${cached ? "Cached" : "Browsed"}: ${scraped.title.slice(0, 60)}`);
          } catch (err) {
            errors.push(`Failed: ${result.url} — ${(err as Error).message}`);
          }
        }),
      );

      // Format output
      const sections: string[] = [
        `## Scout: "${params.query}"`,
        `Found ${relevant.length}/${rawResults.length} relevant results, browsed ${browseResults.length}.`,
      ];

      if (errors.length > 0) {
        sections.push(`\n**Errors:** ${errors.join("; ")}`);
      }

      // Show unbrowsed search results for reference
      const unbrowsed = fresh.slice(maxBrowse, maxBrowse + 5);
      if (unbrowsed.length > 0) {
        sections.push(`\n**Other relevant results (not browsed):**`);
        for (const r of unbrowsed) {
          sections.push(`- ${r.title}: ${r.url}`);
        }
      }

      for (const br of browseResults) {
        sections.push(``);
        sections.push(`### ${br.title}`);
        sections.push(`**Source:** ${br.url} (${br.rawLength} chars)`);
        sections.push(``);
        sections.push(br.content);
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
        details: {
          query: params.query,
          totalResults: rawResults.length,
          relevantResults: relevant.length,
          browsedCount: browseResults.length,
          browsedUrls,
        },
      };
    },
  };
}
