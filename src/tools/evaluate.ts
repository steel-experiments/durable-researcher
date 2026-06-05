// ABOUTME: evaluate_progress tool — formats current research state for the agent to reason about.
// ABOUTME: Surfaces accumulated notes, source count, and mode-aware completion gating.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResearchLedger, ResearchNote, TaskMode } from "../types.js";
import { rankNotes } from "../notes-ranker.js";

const EvaluateParams = Type.Object({});

/** Build the mode-specific Decision Guidance block. */
function decisionGuidance(mode: TaskMode, ledger?: ResearchLedger): string[] {
  const openRequired = ledger?.requiredClaims.filter((item) => item.status === "open") ?? [];
  const contradictedRequired = ledger?.requiredClaims.filter((item) => item.status === "contradicted") ?? [];
  const contestedClaims = ledger?.claims.filter((claim) => claim.status === "contested") ?? [];
  const thinClaims = ledger?.claims.filter((claim) =>
    claim.status === "supported" && claim.independentCorroboration < 2
  ) ?? [];
  const enoughCoverage = ledger && ledger.requiredClaims.length > 0 && openRequired.length === 0;
  const noUnresolvedContradictions = contradictedRequired.length === 0 && contestedClaims.length === 0;

  if (ledger) {
    const nextStrategy = adaptiveSearchGuidance(ledger);
    return [
      `## Decision Guidance (${mode} mode)`,
      `Ledger-first completion gating:`,
      `- Sufficient only when required claims are answered, contested claims are resolved or explicitly reported, and key conclusions have independent corroboration.`,
      `- Open required claims: ${openRequired.length}`,
      `- Contradicted required claims: ${contradictedRequired.length}`,
      `- Contested ledger claims: ${contestedClaims.length}`,
      `- Supported but thinly corroborated claims: ${thinClaims.length}`,
      ``,
      `### Next Search Strategy`,
      ...nextStrategy.map((item) => `- ${item}`),
      ``,
      enoughCoverage && noUnresolvedContradictions
        ? `Current state is eligible for synthesis if the remaining thin claims are not central, or if their uncertainty is clearly reported.`
        : `Do not synthesize yet unless the budget forces it. Search/browse to answer open required claims, resolve contradictions, or add independent corroboration.`,
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

function adaptiveSearchGuidance(ledger: ResearchLedger): string[] {
  const openRequired = ledger.requiredClaims.filter((item) => item.status === "open");
  const contestedClaims = ledger.claims.filter((claim) => claim.status === "contested");
  const thinClaims = ledger.claims.filter((claim) =>
    claim.status === "supported" && claim.independentCorroboration < 2
  );

  if (contestedClaims.length > 0) {
    return contestedClaims.slice(0, 3).map((claim) =>
      `Drill into contested claim "${claim.text.slice(0, 140)}" with primary-source or official-source queries; record contradicting/supporting evidence on the same claim.`,
    );
  }

  if (openRequired.length > 0) {
    return openRequired.slice(0, 3).map((required) =>
      `Broaden or redirect search for open required claim ${required.id}: ${required.question}`,
    );
  }

  if (thinClaims.length > 0) {
    return thinClaims.slice(0, 3).map((claim) =>
      `Seek independent corroboration for "${claim.text.slice(0, 140)}" from a different source family, not another copy of the same wording.`,
    );
  }

  return [`No ledger-driven search gaps remain; synthesize with uncertainty clearly tied to claim confidence.`];
}

/** Create an evaluate_progress tool that reads current notes and scraped URLs. */
export function createEvaluateTool(
  notes: ResearchNote[],
  scrapedUrls: Set<string>,
  mode: TaskMode = "synthesis",
  ledger?: ResearchLedger,
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
      ];

      if (ledger) {
        const supported = ledger.claims.filter((claim) => claim.status === "supported");
        const contested = ledger.claims.filter((claim) => claim.status === "contested");
        const refuted = ledger.claims.filter((claim) => claim.status === "refuted");
        const openRequired = ledger.requiredClaims.filter((item) => item.status === "open");
        const answeredRequired = ledger.requiredClaims.filter((item) => item.status === "answered");
        const contradictedRequired = ledger.requiredClaims.filter((item) => item.status === "contradicted");
        summary.push(
          `## Claim Ledger`,
          ``,
          `**Claims:** ${ledger.claims.length}`,
          `  - Supported: ${supported.length}`,
          `  - Contested: ${contested.length}`,
          `  - Refuted: ${refuted.length}`,
          `**Evidence links:** ${ledger.evidenceLinks.length}`,
          `**Required claims:** ${ledger.requiredClaims.length}`,
          `  - Answered: ${answeredRequired.length}`,
          `  - Open: ${openRequired.length}`,
          `  - Contradicted: ${contradictedRequired.length}`,
          ``,
        );
        if (openRequired.length > 0) {
          summary.push(`### Open Required Claims`);
          for (const item of openRequired.slice(0, 10)) {
            summary.push(`- ${item.id}: ${item.question}`);
          }
          summary.push(``);
        }
        if (contested.length > 0) {
          summary.push(`### Contested Claims`);
          for (const claim of contested.slice(0, 10)) {
            summary.push(`- [${claim.confidence}] ${claim.text}`);
          }
          summary.push(``);
        }
        if (supported.length > 0) {
          summary.push(`### Supported Claims`);
          for (const claim of supported.slice(0, 12)) {
            summary.push(
              `- [${claim.confidence}, ${claim.independentCorroboration} independent] ${claim.text.slice(0, 220)}${claim.text.length > 220 ? "..." : ""}`,
            );
          }
          summary.push(``);
        }
      }

      summary.push(
        `## Notes Summary`,
      );

      // Show notes in quality-ranked order
      const ranked = rankNotes(notes);
      for (const note of ranked) {
        summary.push(
          `- [${note.confidence}] **${note.title}**: ${note.content.slice(0, 200)}${note.content.length > 200 ? "..." : ""}`,
        );
      }

      summary.push(``, ...decisionGuidance(mode, ledger));

      return {
        content: [{ type: "text" as const, text: summary.join("\n") }],
        details: {
          noteCount: notes.length,
          sourceCount: scrapedUrls.size,
          domainCount: uniqueDomains.size,
          mode,
          ...(ledger
            ? {
                claimCount: ledger.claims.length,
                evidenceLinkCount: ledger.evidenceLinks.length,
                requiredClaimCount: ledger.requiredClaims.length,
                openRequiredClaimCount: ledger.requiredClaims.filter((item) => item.status === "open").length,
                contestedClaimCount: ledger.claims.filter((claim) => claim.status === "contested").length,
              }
            : {}),
        },
      };
    },
  };
}
