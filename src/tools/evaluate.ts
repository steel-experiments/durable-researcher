// ABOUTME: evaluate_progress tool — formats current research state for the agent to reason about.
// ABOUTME: Surfaces accumulated notes, source count, and coverage gaps to guide next steps.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResearchNote } from "../types.js";
import { rankNotes } from "../notes-ranker.js";

const EvaluateParams = Type.Object({});

/** Create an evaluate_progress tool that reads current notes and scraped URLs. */
export function createEvaluateTool(
  notes: ResearchNote[],
  scrapedUrls: Set<string>,
): AgentTool<typeof EvaluateParams> {
  return {
    name: "evaluate_progress",
    label: "Evaluate Progress",
    description:
      "Assess current research coverage. Call this after browsing several sources to decide whether to continue searching or synthesize findings.",
    parameters: EvaluateParams,
    execute: async () => {
      const highConfidence = notes.filter((n) => n.confidence === "high");
      const mediumConfidence = notes.filter((n) => n.confidence === "medium");
      const lowConfidence = notes.filter((n) => n.confidence === "low");

      // Collect all unique source domains
      const allSourceUrls = notes.flatMap((n) => n.sourceUrls);
      const uniqueDomains = new Set(
        allSourceUrls.map((u) => {
          try {
            return new URL(u).hostname;
          } catch {
            return u;
          }
        }),
      );

      const summary = [
        `## Research Progress`,
        ``,
        `**Sources scraped:** ${scrapedUrls.size}`,
        `**Unique source domains:** ${uniqueDomains.size}`,
        `**Total notes:** ${notes.length}`,
        `  - High confidence: ${highConfidence.length}`,
        `  - Medium confidence: ${mediumConfidence.length}`,
        `  - Low confidence: ${lowConfidence.length}`,
        ``,
        `## Notes Summary`,
      ];

      // Show notes in quality-ranked order
      const ranked = rankNotes(notes);
      for (const note of ranked) {
        summary.push(
          `- [${note.confidence}] **${note.title}**: ${note.content.slice(0, 200)}${note.content.length > 200 ? "..." : ""}`,
        );
      }

      summary.push(
        ``,
        `## Decision Guidance`,
        `Based on the above, decide:`,
        `- If you have sufficient high-confidence notes covering the topic → synthesize your report`,
        `- If there are clear gaps or low-confidence areas → search for more sources targeting those gaps`,
        `- If you have many notes but low diversity of sources → search for alternative perspectives`,
      );

      return {
        content: [{ type: "text" as const, text: summary.join("\n") }],
        details: {
          noteCount: notes.length,
          sourceCount: scrapedUrls.size,
          domainCount: uniqueDomains.size,
        },
      };
    },
  };
}
