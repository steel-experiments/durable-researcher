// ABOUTME: web_search tool — multi-engine web search via Steel with URL deduplication.
// ABOUTME: Tries Google, then Bing, then DuckDuckGo. Optionally routes to EDGAR for SEC filings.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { multiEngineSearch, filterByRelevance } from "../steel-client.js";
import { searchEdgar } from "../edgar.js";
import type { TaskMode } from "../types.js";

const SearchParams = Type.Object({
  query: Type.String({ description: "The search query to execute" }),
  source: Type.Optional(
    Type.Union(
      [Type.Literal("web"), Type.Literal("edgar")],
      {
        description:
          "Where to search. 'web' (default) hits Bing/DDG/Google via Steel. 'edgar' hits the SEC full-text filing search — use this for 10-K / 10-Q / 8-K filings and other SEC primary documents.",
      },
    ),
  ),
});

/** Create a web_search tool that filters out already-scraped URLs. */
export function createSearchTool(
  client: Steel,
  scrapedUrls: Set<string>,
  researchTopic?: string,
  mode?: TaskMode,
): AgentTool<typeof SearchParams> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web (or SEC EDGAR via `source: 'edgar'`) for information. Returns a list of titles, URLs, and snippets. Already-visited URLs are filtered out.",
    parameters: SearchParams,
    execute: async (_toolCallId, params) => {
      const source = params.source ?? "web";
      const rawResults = source === "edgar"
        ? await searchEdgar(params.query, { limit: 15 })
        : await multiEngineSearch(client, params.query);
      // Score against both topic and the specific query — a result matching
      // the query is relevant even if it doesn't match the broad topic.
      // EDGAR results are already from a topic-targeted index, so skip the
      // keyword filter (filing titles rarely overlap lexically with topics).
      // Lookup mode also skips the gate: a needle query is precise and often
      // shares only one keyword with the answer page, which the ≥2-keyword
      // gate would score 0 and drop. Trust the agent's query and return the
      // raw engine ranking instead.
      const skipFilter = source === "edgar" || mode === "lookup";
      const relevant = (researchTopic && !skipFilter)
        ? filterByRelevance(rawResults, researchTopic, 0.2, params.query)
        : rawResults;

      // Filter out already-visited URLs
      const fresh = relevant.filter((r) => !scrapedUrls.has(r.url));

      if (fresh.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No new results found for "${params.query}". ${rawResults.length} results found, ${relevant.length} relevant, all already visited. Try a different query.`,
            },
          ],
          details: { totalResults: rawResults.length, relevantResults: relevant.length, freshResults: 0 },
        };
      }

      const formatted = fresh
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${fresh.length} new results for "${params.query}":\n\n${formatted}`,
          },
        ],
        details: {
          totalResults: rawResults.length,
          relevantResults: relevant.length,
          freshResults: fresh.length,
        },
      };
    },
  };
}
