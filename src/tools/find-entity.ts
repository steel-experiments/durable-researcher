// ABOUTME: find_entity tool — resolve a known named entity (paper, system, benchmark…) to canonical sources fast.
// ABOUTME: Builds kind-tailored queries so survey gap-fills skip wide search and land on the document of record.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { searchAndBrowse } from "./scout.js";
import type { ToolProgress } from "../event-bus.js";
import type { UrlExcerptStore } from "../url-excerpts.js";

const EntityKinds = ["paper", "system", "benchmark", "person", "org", "metric"] as const;
type EntityKind = (typeof EntityKinds)[number];

const FindEntityParams = Type.Object({
  name: Type.String({ description: "The exact name of the entity to find (e.g. 'AGDebugger', 'τ-bench')" }),
  kind: Type.Optional(
    Type.Union(
      EntityKinds.map((k) => Type.Literal(k)),
      { description: "What kind of entity it is — routes to the right source type" },
    ),
  ),
});

/** Pages to browse per query attempt — entity lookups want depth-1, not breadth. */
const ENTITY_MAX_BROWSE = 2;
/** How many tailored queries to try before giving up. */
const MAX_QUERY_ATTEMPTS = 2;

/**
 * Build prioritized, kind-tailored search queries for a named entity.
 * Earlier queries target the document of record (arxiv for papers, official
 * docs for systems); later queries are broader fallbacks.
 */
export function buildEntityQueries(name: string, kind?: EntityKind): string[] {
  switch (kind) {
    case "paper":
      return [`${name} arxiv`, `${name} paper abstract`];
    case "system":
      return [`${name} official documentation`, `${name} github`];
    case "benchmark":
      return [`${name} benchmark paper`, `${name} dataset leaderboard`];
    case "person":
      return [`${name} research publications`, `${name} google scholar`];
    case "org":
      return [`${name} official site`, `${name} research`];
    case "metric":
      return [`${name} definition metric`, `${name} how measured`];
    default:
      return [`${name}`, `${name} overview`];
  }
}

/** Create a find_entity tool that resolves a named entity to canonical sources. */
export function createFindEntityTool(
  client: Steel,
  scrapedUrls: Set<string>,
  topic: string,
  taskId?: string,
  progress?: ToolProgress,
  urlExcerpts?: UrlExcerptStore,
): AgentTool<typeof FindEntityParams> {
  const report = progress ?? ((text: string) => console.log(text));
  return {
    name: "find_entity",
    label: "Find Entity",
    description:
      "Resolve a KNOWN named entity (a specific paper, system, benchmark, person, org, or metric) to its canonical sources. " +
      "Faster and more reliable than scout for entity lookups — it queries the document of record directly (arxiv, official docs, etc.). " +
      "Use this to fill the named gaps that gap_analysis surfaces.",
    parameters: FindEntityParams,
    execute: async (_toolCallId, params) => {
      const queries = buildEntityQueries(params.name, params.kind as EntityKind | undefined).slice(
        0,
        MAX_QUERY_ATTEMPTS,
      );

      const sections: string[] = [];
      const allBrowsedUrls: string[] = [];
      let totalBrowsed = 0;

      for (const query of queries) {
        const outcome = await searchAndBrowse({
          client,
          query,
          topic,
          scrapedUrls,
          maxBrowse: ENTITY_MAX_BROWSE,
          report,
          label: "ENTITY",
          focus: `information about ${params.name}`,
          taskId,
          urlExcerpts,
        });
        sections.push(outcome.text);
        allBrowsedUrls.push(...outcome.browsedUrls);
        totalBrowsed += outcome.browsedCount;
        // Stop as soon as a query yields a real page — no need to burn the fallback.
        if (outcome.browsedCount > 0) break;
      }

      const header =
        totalBrowsed > 0
          ? `## find_entity: "${params.name}"${params.kind ? ` (${params.kind})` : ""} — browsed ${totalBrowsed} page(s)`
          : `## find_entity: "${params.name}" — no sources found. Try scout with a broader query, or note the gap.`;

      return {
        content: [{ type: "text" as const, text: [header, ...sections].join("\n\n") }],
        details: {
          name: params.name,
          kind: params.kind ?? null,
          queriesTried: queries,
          browsedCount: totalBrowsed,
          browsedUrls: allBrowsedUrls,
        },
      };
    },
  };
}
