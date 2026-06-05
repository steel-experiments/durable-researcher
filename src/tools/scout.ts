// ABOUTME: scout tool — search a query and browse top results in one call.
// ABOUTME: Saves 1-2 LLM turns per follow-up cycle by combining search + browse into a single tool.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { multiEngineSearch, filterByRelevance } from "../steel-client.js";
import { browseOne, type BrowseOneResult } from "./browse.js";
import type { ToolProgress } from "../event-bus.js";
import type { UrlExcerptStore } from "../url-excerpts.js";
import type { TaskMode } from "../types.js";
import {
  type ReferenceQueue,
} from "../reference-queue.js";
import { hasVisitedUrl } from "../url-normalize.js";

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

type SearchAndBrowseDeps = {
  search?: typeof multiEngineSearch;
  filterByRelevance?: typeof filterByRelevance;
  browseOne?: (opts: Parameters<typeof browseOne>[0]) => Promise<BrowseOneResult>;
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
  mode?: TaskMode;
  deps?: SearchAndBrowseDeps;
}): Promise<SearchAndBrowseOutcome> {
  const { client, query, topic, scrapedUrls, maxBrowse, report, focus, taskId, urlExcerpts, referenceQueue, mode } = opts;
  const label = opts.label ?? "SCOUT";
  const search = opts.deps?.search ?? multiEngineSearch;
  const filterResults = opts.deps?.filterByRelevance ?? filterByRelevance;
  const browse = opts.deps?.browseOne ?? browseOne;

  const rawResults = await search(client, query);
  const relevant = mode === "lookup"
    ? rawResults
    : filterResults(rawResults, topic, 0.2, query);
  const fresh = relevant.filter((r) => !hasVisitedUrl(scrapedUrls, r.url));

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
        const browsed = await browse({
          client,
          url: result.url,
          topic,
          scrapedUrls,
          focus,
          taskId,
          urlExcerpts,
          referenceQueue,
        });
        browsedUrls.push(result.url);

        if (!browsed.meaningful) {
          browseResults.push({
            url: result.url,
            title: browsed.title,
            content: "[Insufficient content]",
            rawLength: Number(browsed.details.rawLength ?? 0),
          });
          return;
        }
        const contentRelevant = browsed.details.contentRelevant !== false;
        const relevancePrefix = contentRelevant
          ? ""
          : "[Low content relevance to the research topic]\n\n";

        browseResults.push({
          url: result.url,
          title: browsed.title,
          content: `${relevancePrefix}${String(browsed.details.summary ?? "")}`,
          rawLength: Number(browsed.details.rawLength ?? 0),
        });

        report(`    [${label}] ${browsed.fromCache ? "Cached" : "Browsed"}: ${browsed.title.slice(0, 60)}`);
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
  mode?: TaskMode,
  deps: SearchAndBrowseDeps = {},
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
        mode,
        deps,
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
