// ABOUTME: evaluate_progress tool — formats current research state for the agent to reason about.
// ABOUTME: Surfaces accumulated notes, source count, and mode-aware completion gating.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResearchNote, TaskMode } from "../types.js";
import { rankNotes } from "../notes-ranker.js";

const EvaluateParams = Type.Object({});

/** Build the mode-specific Decision Guidance block. */
function decisionGuidance(mode: TaskMode): string[] {
  if (mode === "lookup") {
    return [
      `## Decision Guidance (lookup mode)`,
      `Lookup-mode completion gating:`,
      `- The deliverable is ONE direct answer with a strong citation.`,
      `- Sufficient ONLY when: (a) the exact answer is recorded in a high-confidence note, AND (b) at least one excerpt verbatim states it.`,
      `- If you have notes that *talk around* the answer but never state it, keep searching — do NOT call your current state sufficient.`,
      `- Once the answer is locked, write the lookup-mode report (Answer / Supporting Detail / Sources) and stop.`,
    ];
  }
  if (mode === "extraction") {
    return [
      `## Decision Guidance (extraction mode)`,
      `Extraction-mode completion gating — list every required value the prompt asks for, with its current state:`,
      ``,
      `For each requested metric, write a line:`,
      `  • <metric name> — extracted (value, period, source) | partial (which parts missing) | missing (why)`,
      ``,
      `Sufficient ONLY when:`,
      `- Every requested metric has at least one extracted value from a primary source.`,
      `- Partial / missing values are explicitly justified (source unavailable, value not reported, etc.).`,
      ``,
      `Do NOT call your current state sufficient with values still missing or only loosely sourced — keep searching primary documents (filings, papers, datasets), not secondary summaries.`,
    ];
  }
  return [
    `## Decision Guidance`,
    `Based on the above, decide:`,
    `- If you have sufficient high-confidence notes covering the topic → synthesize your report`,
    `- If there are clear gaps or low-confidence areas → search for more sources targeting those gaps`,
    `- If you have many notes but low diversity of sources → search for alternative perspectives`,
  ];
}

/** Create an evaluate_progress tool that reads current notes and scraped URLs. */
export function createEvaluateTool(
  notes: ResearchNote[],
  scrapedUrls: Set<string>,
  mode: TaskMode = "synthesis",
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
        `**Task mode:** ${mode}`,
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

      summary.push(``, ...decisionGuidance(mode));

      return {
        content: [{ type: "text" as const, text: summary.join("\n") }],
        details: {
          noteCount: notes.length,
          sourceCount: scrapedUrls.size,
          domainCount: uniqueDomains.size,
          mode,
        },
      };
    },
  };
}
