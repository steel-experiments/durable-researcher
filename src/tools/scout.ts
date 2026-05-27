// ABOUTME: scout tool — search a query and browse top results in one call.
// ABOUTME: Saves 1-2 LLM turns per follow-up cycle by combining search + browse into a single tool.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { multiEngineSearch, filterByRelevance } from "../steel-client.js";
import { isContentMeaningful, truncateContent } from "../content.js";
import { fetchBrowseContent, summarizeContent } from "./browse.js";
import { getCachedBrowse, setCachedBrowse } from "../browse-cache.js";
import type { ToolProgress } from "../event-bus.js";
import { captureExcerptsForUrl, type UrlExcerptStore } from "../url-excerpts.js";
import {
  isPaperLikeUrl,
  extractReferenceCandidates,
  type ReferenceQueue,
} from "../reference-queue.js";

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

/** Content shorter than this is returned raw — preserves specific data, citations, named entities. */
const SMART_SUMMARIZE_THRESHOLD = 10000;

/** Default number of pages to browse per scout call. */
const DEFAULT_MAX_BROWSE = 5;

type ScoutResult = {
  url: string;
  title: string;
  content: string;
  rawLength: number;
};

/** Aggregate outcome of a search-and-browse pass. */
export type SearchAndBrowseOutcome = {
  text: string;
  totalResults: number;
  relevantResults: number;
  browsedCount: number;
  browsedUrls: string[];
};

/**
 * Search a query, filter by relevance, and browse the top fresh results in parallel.
 * Shared by the `scout` and `find_entity` tools. `label` tags the progress/output lines.
 */
export async function searchAndBrowse(opts: {
  client: Steel;
  query: string;
  topic: string;
  scrapedUrls: Set<string>;
  maxBrowse: number;
  report: (text: string) => void;
  label?: string;
  focus?: string;
  taskId?: string;
  urlExcerpts?: UrlExcerptStore;
  referenceQueue?: ReferenceQueue;
}): Promise<SearchAndBrowseOutcome> {
  const { client, query, topic, scrapedUrls, maxBrowse, report, focus, taskId, urlExcerpts, referenceQueue } = opts;
  const label = opts.label ?? "SCOUT";

  const rawResults = await multiEngineSearch(client, query);
  const relevant = filterByRelevance(rawResults, topic, 0.2, query);
  const fresh = relevant.filter((r) => !scrapedUrls.has(r.url));

  if (fresh.length === 0) {
    return {
      text: `${label}: searched "${query}" — ${rawResults.length} results found, ${relevant.length} relevant, none new. Try a different query or browse a known URL directly.`,
      totalResults: rawResults.length,
      relevantResults: relevant.length,
      browsedCount: 0,
      browsedUrls: [],
    };
  }

  const toBrowse = fresh.slice(0, maxBrowse);
  report(`    [${label}] "${query.slice(0, 50)}" → ${relevant.length}/${rawResults.length} relevant, browsing ${toBrowse.length}...`);

  const browseResults: ScoutResult[] = [];
  const browsedUrls: string[] = [];
  const errors: string[] = [];

  await Promise.allSettled(
    toBrowse.map(async (result) => {
      try {
        let scraped: { content: string; title: string; rawLength: number };

        const cached = taskId ? await getCachedBrowse(taskId, result.url).catch(() => null) : null;
        if (cached) {
          scraped = { content: cached.content, title: cached.title, rawLength: cached.rawLength };
        } else {
          scraped = await fetchBrowseContent(client, result.url);
        }

        scrapedUrls.add(result.url);
        browsedUrls.push(result.url);

        const meaningful = isContentMeaningful(scraped.content);

        // Skip caching dead pages — see browse.ts for the rationale.
        if (!cached && taskId && meaningful) {
          await setCachedBrowse(taskId, result.url, scraped).catch(() => {});
        }

        if (!meaningful) {
          browseResults.push({
            url: result.url,
            title: scraped.title,
            content: "[Insufficient content]",
            rawLength: scraped.rawLength,
          });
          return;
        }

        // Harvest references from primary sources for later chasing.
        if (referenceQueue && isPaperLikeUrl(result.url)) {
          referenceQueue.add(extractReferenceCandidates(scraped.content));
        }

        // Smart summarization: short content raw, long content LLM-summarized
        let processedContent: string;
        if (scraped.content.length <= SMART_SUMMARIZE_THRESHOLD) {
          processedContent = scraped.content;
        } else {
          try {
            processedContent = await summarizeContent(scraped.content, topic, focus);
          } catch {
            processedContent = truncateContent(scraped.content, 4000);
          }
        }

        captureExcerptsForUrl(urlExcerpts, result.url, {
          summary: processedContent,
          content: scraped.content,
        });

        browseResults.push({
          url: result.url,
          title: scraped.title,
          content: processedContent,
          rawLength: scraped.rawLength,
        });

        report(`    [${label}] ${cached ? "Cached" : "Browsed"}: ${scraped.title.slice(0, 60)}`);
      } catch (err) {
        errors.push(`Failed: ${result.url} — ${(err as Error).message}`);
      }
    }),
  );

  const sections: string[] = [
    `## ${label}: "${query}"`,
    `Found ${relevant.length}/${rawResults.length} relevant results, browsed ${browseResults.length}.`,
  ];

  if (errors.length > 0) {
    sections.push(`\n**Errors:** ${errors.join("; ")}`);
  }

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
    text: sections.join("\n"),
    totalResults: rawResults.length,
    relevantResults: relevant.length,
    browsedCount: browseResults.length,
    browsedUrls,
  };
}

/** Create a scout tool that searches and browses in one call. */
export function createScoutTool(
  client: Steel,
  scrapedUrls: Set<string>,
  topic: string,
  taskId?: string,
  progress?: ToolProgress,
  urlExcerpts?: UrlExcerptStore,
  referenceQueue?: ReferenceQueue,
): AgentTool<typeof ScoutParams> {
  const report = progress ?? ((text: string) => console.log(text));
  return {
    name: "scout",
    label: "Scout",
    description:
      "Search for a query AND browse the top results in one step. Returns search results plus content from the most relevant pages. Faster than sequential search → browse when you need to fill a specific gap.",
    parameters: ScoutParams,
    execute: async (_toolCallId, params) => {
      const outcome = await searchAndBrowse({
        client,
        query: params.query,
        topic,
        scrapedUrls,
        maxBrowse: params.maxBrowse ?? DEFAULT_MAX_BROWSE,
        report,
        label: "SCOUT",
        focus: params.focus,
        taskId,
        urlExcerpts,
        referenceQueue,
      });
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        details: {
          query: params.query,
          totalResults: outcome.totalResults,
          relevantResults: outcome.relevantResults,
          browsedCount: outcome.browsedCount,
          browsedUrls: outcome.browsedUrls,
        },
      };
    },
  };
}
