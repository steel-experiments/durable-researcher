// ABOUTME: web_search tool — multi-engine web search via Steel with URL deduplication.
// ABOUTME: Tries Google, then Bing, then DuckDuckGo. Filters out already-visited URLs.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { multiEngineSearch } from "../steel-client.js";

const SearchParams = Type.Object({
  query: Type.String({ description: "The search query to execute" }),
});

/** Create a web_search tool that filters out already-scraped URLs. */
export function createSearchTool(
  client: Steel,
  scrapedUrls: Set<string>,
): AgentTool<typeof SearchParams> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for information. Returns a list of titles, URLs, and snippets. Already-visited URLs are filtered out.",
    parameters: SearchParams,
    execute: async (_toolCallId, params) => {
      const results = await multiEngineSearch(client, params.query);

      // Filter out already-visited URLs
      const fresh = results.filter((r) => !scrapedUrls.has(r.url));

      if (fresh.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No new results found for "${params.query}". All ${results.length} results have already been visited. Try a different query.`,
            },
          ],
          details: { totalResults: results.length, freshResults: 0 },
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
          totalResults: results.length,
          freshResults: fresh.length,
        },
      };
    },
  };
}
