// ABOUTME: Campaign progress judging and finalization policy.
// ABOUTME: Separates LLM/heuristic scoring from campaign persistence and orchestration.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getAgentModel, getAgentReasoning } from "./config.js";
import type {
  CampaignDecision,
  CampaignParams,
  CampaignRecord,
  ResearchNote,
} from "./types.js";

export const DEFAULT_PULSE_MAX_SOURCES = 20;
const DEFAULT_MIN_NOVELTY_SCORE = 0.08;
const DEFAULT_MIN_COVERAGE_SCORE = 0.86;
const DEFAULT_MIN_AUDITABILITY_SCORE = 0.78;

export type CampaignJudgeInput = {
  campaign: CampaignRecord;
  pulseIndex: number;
  latestReport: string;
  notes: ResearchNote[];
  totalSources: number;
  newSourceCount: number;
  newNoteCount: number;
  verificationPassRate?: number;
  verificationTotal?: number;
  verificationStatus?: "passed" | "failed" | "no_claims";
};

export type HeuristicCampaignDecisionInput = Omit<CampaignJudgeInput, "campaign" | "latestReport">;

export function shouldFinalizeFromDecision(params: CampaignParams, decision: CampaignDecision): boolean {
  if (decision.decision === "finalize" || decision.decision === "stop_budget_exhausted") return true;
  if (params.stopWhenGoalMet !== false) {
    const goodEnough =
      decision.coverageScore >= DEFAULT_MIN_COVERAGE_SCORE &&
      decision.auditabilityScore >= DEFAULT_MIN_AUDITABILITY_SCORE;
    if (goodEnough && decision.remainingGaps.length === 0) return true;
  }
  if (params.stopWhenExhaustedSources !== false && decision.noveltyScore < DEFAULT_MIN_NOVELTY_SCORE) {
    return true;
  }
  return false;
}

export function heuristicCampaignDecision(input: HeuristicCampaignDecisionInput): CampaignDecision {
  const highNotes = input.notes.filter((n) => n.confidence === "high");
  const notesWithExcerpts = input.notes.filter((n) => n.keyExcerpts && n.keyExcerpts.length > 0);
  const verificationUsable = input.verificationStatus === "passed" && (input.verificationTotal ?? 0) > 0;
  const coverageScore = Math.min(
    0.98,
    Math.max(
      verificationUsable ? input.verificationPassRate ?? 0 : 0,
      0.18 + highNotes.length * 0.035 + input.totalSources * 0.012,
    ),
  );
  const noveltyScore = input.totalSources === 0
    ? 1
    : input.newSourceCount / Math.max(1, Math.min(input.totalSources, DEFAULT_PULSE_MAX_SOURCES));
  const auditabilityScore = input.notes.length === 0 ? 0 : notesWithExcerpts.length / input.notes.length;
  const remainingGaps = [
    ...(input.verificationStatus === "no_claims"
      ? ["Repair report auditability: rewrite with numeric inline citations like [1] for source-backed claims."]
      : []),
    ...(input.verificationStatus === "failed"
      ? ["Strengthen citation grounding for unsupported claims before final synthesis."]
      : []),
    ...(coverageScore >= DEFAULT_MIN_COVERAGE_SCORE ? [] : [
      "Need more high-confidence source-backed findings before final synthesis.",
    ]),
  ];
  const exhausted = input.pulseIndex > 0 && input.newSourceCount === 0 && input.newNoteCount === 0;
  return {
    decision: exhausted || (
      remainingGaps.length === 0 &&
      coverageScore >= DEFAULT_MIN_COVERAGE_SCORE &&
      auditabilityScore >= DEFAULT_MIN_AUDITABILITY_SCORE
    )
      ? "finalize"
      : "continue",
    reason: exhausted ? "no new evidence found in latest pulse" : "heuristic progress assessment",
    coverageScore,
    noveltyScore,
    auditabilityScore,
    remainingGaps,
    nextObjective: remainingGaps[0] ?? "Deepen the strongest unresolved angles and seek primary or independent corroborating sources.",
  };
}

export async function judgeCampaignProgress(input: CampaignJudgeInput): Promise<CampaignDecision> {
  const fallback = heuristicCampaignDecision(input);
  const model = getAgentModel();
  try {
    const noteSummary = input.notes
      .slice(-40)
      .map((n) => `- [${n.confidence}] ${n.title}: ${n.content.slice(0, 260)}`)
      .join("\n");
    const msg = await completeSimple(model, {
      systemPrompt: [
        "You are the autonomous judge for a long-running research campaign.",
        "Decide whether the campaign should continue, finalize, or stop because budget is exhausted.",
        "Optimize for best final report AND auditability. Continue only when more research is likely to add meaningful evidence.",
        "Output exactly one JSON object with keys: decision, reason, coverageScore, noveltyScore, auditabilityScore, remainingGaps, nextObjective.",
      ].join("\n"),
      messages: [{
        role: "user" as const,
        content: [
          `Topic: ${input.campaign.topic}`,
          `Pulse: ${input.pulseIndex}`,
          `Total sources: ${input.totalSources}`,
          `New sources this pulse: ${input.newSourceCount}`,
          `New notes this pulse: ${input.newNoteCount}`,
          `Verification pass rate: ${input.verificationPassRate ?? "unknown"}`,
          `Verification total claims: ${input.verificationTotal ?? "unknown"}`,
          `Verification status: ${input.verificationStatus ?? "unknown"}`,
          input.verificationStatus === "no_claims"
            ? "A no_claims verification status means the report had no parseable numeric inline citations and must be treated as low auditability."
            : null,
          "",
          "Recent notes:",
          noteSummary || "(none)",
          "",
          "Latest report excerpt:",
          input.latestReport.slice(0, 4000),
        ].filter((line): line is string => line !== null).join("\n"),
        timestamp: Date.now(),
      }],
    }, {
      maxTokens: 800,
      apiKey: getEnvApiKey(model.provider),
      reasoning: getAgentReasoning(),
    });
    const text = msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "");
    const parsed = JSON.parse(text) as CampaignDecision;
    const verificationBlocksFinalize =
      input.verificationStatus === "no_claims" || input.verificationStatus === "failed";
    const parsedDecision = parsed.decision === "finalize" || parsed.decision === "stop_budget_exhausted"
      ? parsed.decision
      : "continue";
    return {
      decision: verificationBlocksFinalize && parsedDecision === "finalize" ? "continue" : parsedDecision,
      reason: parsed.reason || fallback.reason,
      coverageScore: clampScore(parsed.coverageScore, fallback.coverageScore),
      noveltyScore: clampScore(parsed.noveltyScore, fallback.noveltyScore),
      auditabilityScore: clampScore(parsed.auditabilityScore, fallback.auditabilityScore),
      remainingGaps: Array.isArray(parsed.remainingGaps) ? parsed.remainingGaps.map(String) : fallback.remainingGaps,
      nextObjective: parsed.nextObjective ? String(parsed.nextObjective) : fallback.nextObjective,
    };
  } catch {
    return fallback;
  }
}

function clampScore(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}
