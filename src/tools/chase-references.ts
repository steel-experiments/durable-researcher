// ABOUTME: chase_references tool — follow the citation graph of papers already browsed.
// ABOUTME: Pulls reference candidates (agent-supplied + auto-harvested queue) and browses them.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { browseOne } from "./browse.js";
import { searchAndBrowse } from "./scout.js";
import type { ReferenceQueue } from "../reference-queue.js";
import type { ToolProgress } from "../event-bus.js";
import type { UrlExcerptStore } from "../url-excerpts.js";

const ChaseParams = Type.Object({
  references: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Specific references to chase — URLs or paper titles you spotted in a source's bibliography. " +
        "Optional: if omitted, the tool pulls auto-harvested references from papers you've already browsed.",
    }),
  ),
});

/** Max references chased per call — bounds the citation-graph fan-out. */
const MAX_CHASE = 5;

function looksLikeUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref.trim());
}

/** Create a chase_references tool backed by a per-task reference queue. */
export function createChaseReferencesTool(
  client: Steel,
  scrapedUrls: Set<string>,
  topic: string,
  referenceQueue: ReferenceQueue,
  taskId?: string,
  progress?: ToolProgress,
  urlExcerpts?: UrlExcerptStore,
): AgentTool<typeof ChaseParams> {
  const report = progress ?? ((text: string) => console.log(text));
  return {
    name: "chase_references",
    label: "Chase References",
    description:
      "Follow the citation graph: browse references cited by papers you've already read. Pass specific URLs or titles " +
      "from a bibliography, or call with no arguments to chase references auto-harvested from primary sources. " +
      "Bounded to a few per call — use 1-2 times per run to deepen a literature survey.",
    parameters: ChaseParams,
    execute: async (_toolCallId, params) => {
      // Combine agent-supplied refs with auto-harvested queue entries, deduped vs visited.
      const explicit = (params.references ?? []).map((r) => r.trim()).filter(Boolean);
      const refs: string[] = [];
      for (const r of explicit) {
        if (refs.length >= MAX_CHASE) break;
        if (looksLikeUrl(r) && scrapedUrls.has(r)) continue;
        refs.push(r);
      }
      if (refs.length < MAX_CHASE) {
        refs.push(...referenceQueue.drain(MAX_CHASE - refs.length));
      }

      if (refs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `chase_references: no references to chase (queue empty, none supplied). Browse a paper first, or pass explicit references/titles.`,
            },
          ],
          details: { chased: 0, browsedUrls: [], queueRemaining: referenceQueue.size },
        };
      }

      report(`    [CHASE] following ${refs.length} reference(s)...`);

      const sections: string[] = [];
      const browsedUrls: string[] = [];
      let browsedCount = 0;

      for (const ref of refs) {
        if (looksLikeUrl(ref)) {
          if (scrapedUrls.has(ref)) continue;
          try {
            const result = await browseOne({
              client,
              url: ref,
              topic,
              scrapedUrls,
              focus: "core contribution and findings",
              taskId,
              urlExcerpts,
              referenceQueue,
            });
            sections.push(result.text);
            if (result.meaningful) {
              browsedCount++;
              browsedUrls.push(ref);
            }
          } catch (err) {
            sections.push(`Failed to browse ${ref}: ${(err as Error).message}`);
          }
        } else {
          // Title-like reference — search for it.
          const outcome = await searchAndBrowse({
            client,
            query: ref,
            topic,
            scrapedUrls,
            maxBrowse: 1,
            report,
            label: "CHASE",
            focus: "core contribution and findings",
            taskId,
            urlExcerpts,
            referenceQueue,
          });
          sections.push(outcome.text);
          browsedCount += outcome.browsedCount;
          browsedUrls.push(...outcome.browsedUrls);
        }
      }

      const header = `## chase_references — browsed ${browsedCount} page(s), ${referenceQueue.size} left in queue`;
      return {
        content: [{ type: "text" as const, text: [header, ...sections].join("\n\n") }],
        details: { chased: refs.length, browsedCount, browsedUrls, queueRemaining: referenceQueue.size },
      };
    },
  };
}
