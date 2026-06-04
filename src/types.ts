// ABOUTME: Shared type definitions for the durable research agent.
// ABOUTME: Defines message log entries, research parameters, refined content, notes, and results.

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** A single entry in the durable message log, persisted as an Absurd step. */
export type MessageLogEntry = { message: AgentMessage };

/** Task modes the research loop adapts to. Canonical list lives in classify.ts (TASK_MODES). */
export type TaskMode = "lookup" | "extraction" | "synthesis" | "survey";

/** Parameters for spawning a research task. */
export type ResearchParams = {
  topic: string;
  depth?: "quick" | "standard" | "deep";
  maxSources?: number;
  /** Optional token ceiling for this individual research task. */
  maxTokens?: number;
  /** User's clarifying answers to narrow research scope. */
  clarifications?: string;
  /** Prior research notes to extend (from a completed run). */
  priorNotes?: ResearchNote[];
  /** Prior source URLs to avoid re-browsing. */
  priorUrls?: string[];
  /** User instruction for how an extension run should deepen or redirect prior research. */
  extensionInstruction?: string;
  /** Override the auto-classified task mode. */
  mode?: TaskMode;
  /**
   * Whether this task may write and run code adapters. Defaults to true. Set false to
   * quarantine agents that read untrusted web content: a browsing agent with no
   * adapter tools cannot be steered by page content into generating/executing code.
   */
  allowAdapters?: boolean;
};

/** Long-running campaign status. Campaigns orchestrate many bounded research pulses. */
export type CampaignStatus =
  | "running"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed";

/** User-controlled campaign budgets. Undefined values are unbounded. */
export type CampaignBudgets = {
  maxDurationMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxSources?: number;
  /** Budget kept aside for final synthesis and verification work. */
  finalizationReserveRatio?: number;
};

/** Persisted usage ledger for a whole campaign or a single pulse. */
export type CampaignUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  sources: number;
  models: Record<string, { input: number; output: number }>;
};

/** Campaign-level params. Kept API-friendly so a future service can reuse them. */
export type CampaignParams = {
  topic: string;
  depth?: "quick" | "standard" | "deep";
  pulseDepth?: "quick" | "standard" | "deep";
  pulseMaxSources?: number;
  budgets: CampaignBudgets;
  mode?: TaskMode;
  clarify?: string;
  stopWhenGoalMet?: boolean;
  stopWhenExhaustedSources?: boolean;
};

/** High-level evaluator decision after a pulse. */
export type CampaignDecision = {
  decision: "continue" | "finalize" | "stop_budget_exhausted";
  reason: string;
  coverageScore: number;
  noveltyScore: number;
  auditabilityScore: number;
  remainingGaps: string[];
  nextObjective: string | null;
};

/** Persisted campaign record. */
export type CampaignRecord = {
  id: string;
  topic: string;
  status: CampaignStatus;
  params: CampaignParams;
  budgets: CampaignBudgets;
  usage: CampaignUsage;
  createdAt: Date;
  updatedAt: Date;
  deadlineAt: Date | null;
  finalReport: string | null;
  stopReason: string | null;
};

/** One bounded research episode inside a campaign. */
export type CampaignPulse = {
  id: number;
  campaignId: string;
  pulseIndex: number;
  taskId: string | null;
  queueName: string | null;
  objective: string;
  status: "running" | "completed" | "failed";
  startedAt: Date;
  endedAt: Date | null;
  report: string | null;
  result: ResearchResult | null;
  decision: CampaignDecision | null;
  usage: CampaignUsage | null;
};

/**
 * Depth config maps depth labels to loop budgets.
 * - maxIterations: evaluate→scout cycles before the loop is nudged to synthesize
 * - initialQueries: sub-queries the planner generates up front
 * - maxSources: default browse ceiling when the caller doesn't pin maxSources
 * - gapPasses: how many times survey/synthesis runs may call gap_analysis to fill holes
 */
export const DEPTH_CONFIG = {
  quick: { maxIterations: 2, initialQueries: 4, maxSources: 20, gapPasses: 0 },
  standard: { maxIterations: 5, initialQueries: 7, maxSources: 50, gapPasses: 1 },
  deep: { maxIterations: 10, initialQueries: 12, maxSources: 80, gapPasses: 2 },
} as const;

/** Content that has been scraped and summarized by the browse tool. */
export type RefinedContent = {
  title: string;
  url: string;
  summary: string;
  rawLength: number;
  scrapedAt: number;
};

/**
 * Provenance quality of a note's backing source(s), most authoritative first:
 * primary (original research / institutional / official), secondary (reputable
 * reporting), blog (individual opinion), forum (user-generated), unreliable
 * (marketing / SEO / unverifiable). Used to cap a note's confidence to its evidence.
 */
export type SourceTier = "primary" | "secondary" | "blog" | "forum" | "unreliable";

/** A structured research finding recorded by the agent. */
export type ResearchNote = {
  title: string;
  content: string;
  sourceUrls: string[];
  confidence: "high" | "medium" | "low";
  /** Verbatim quotes from sources backing this note. Used by claim verification. */
  keyExcerpts?: string[];
  /** Provenance quality of the backing source(s); caps confidence (blog→medium, forum/unreliable→low). */
  sourceTier?: SourceTier;
};

/**
 * Max verbatim excerpts retained per note (and per URL in the urlExcerpts fallback).
 * Raised from 4 to 8 so survey/synthesis reports — which often make many fine-grained
 * claims per source (year, venue, metric, contribution) — have broader excerpt coverage
 * for the citation verifier to ground against.
 */
export const MAX_EXCERPTS_PER_NOTE = 8;
/** Max characters per excerpt — long enough to carry a useful quote, short enough to stay tight. */
export const MAX_EXCERPT_LENGTH = 240;

/** One candidate reading of the research question — literal or a lateral decode. */
export type PlanInterpretation = {
  /** "literal" or "lateral". */
  reading: string;
  /** For lateral readings: homophone | pun | anagram | paraphrase | reference | descriptor | association. */
  device?: string;
  /** The decoded meaning of this reading. */
  meaning: string;
  /** What to search for to test this reading. */
  queriesTarget?: string;
};

/** The research plan generated by the plan_research tool. */
export type ResearchPlan = {
  /** Literal + lateral readings of the question, recorded before queries are generated. */
  interpretations?: PlanInterpretation[];
  strategicPlan: string;
  subQueries: string[];
  searchStrategy: "breadth-first" | "depth-first" | "mixed";
  estimatedSteps: number;
};

/** A single search result from a SERP scrape. */
export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

/** Addressable source used by explanation artifacts. */
export type ExplanationSource = {
  id: string;
  title: string;
  url: string;
};

/** Verbatim source text retained for provenance in explanation artifacts. */
export type EvidenceExcerpt = {
  id: string;
  evidenceId: string;
  text: string;
  sourceUrl?: string;
};

/** A normalized piece of evidence derived from a durable research note. */
export type Evidence = {
  id: string;
  title: string;
  content: string;
  sourceUrls: string[];
  excerptIds: string[];
  confidence: "high" | "medium" | "low";
};

/** A report claim with addressable links back to evidence and excerpts. */
export type Claim = {
  id: string;
  text: string;
  sourceUrls: string[];
  evidenceIds: string[];
  excerptIds: string[];
  confidence: "high" | "medium" | "low";
  verification?: {
    supported: boolean;
    reason: string;
  };
};

export type ReasoningStep = {
  id: string;
  title: string;
  content: string;
  evidenceIds: string[];
};

export type Uncertainty = {
  id: string;
  description: string;
  severity: "low" | "medium" | "high";
  evidenceIds: string[];
};

export type ExtractionEvidenceTableRow = {
  id: string;
  label: string;
  fields?: { label: string; value: string }[];
  confidence: "high" | "medium" | "low";
  sourceIds: string[];
  evidenceIds: string[];
  excerptIds: string[];
  missingFields: string[];
};

export type ArtifactSpec =
  | {
      kind: "extraction_evidence_table";
      title: string;
      rows: ExtractionEvidenceTableRow[];
    }
  | {
      kind: "comparison_matrix";
      title: string;
      rows: string[];
      columns: string[];
      cells: { row: string; column: string; value: string; claimId?: string; evidenceIds: string[] }[];
    }
  | {
      kind: "timeline";
      title: string;
      events: { id: string; label: string; date?: string; claimId?: string; evidenceIds: string[] }[];
    }
  | {
      kind: "claim_graph";
      title: string;
      nodes: { id: string; label: string; claimId?: string; evidenceIds: string[] }[];
      edges: { from: string; to: string; label?: string; evidenceIds: string[] }[];
    };

/** Canonical explanatory layer: truth/provenance first, presentation second. */
export type ExplanationModel = {
  answer: string;
  claims: Claim[];
  evidence: Evidence[];
  excerpts: EvidenceExcerpt[];
  sources: ExplanationSource[];
  reasoningSteps: ReasoningStep[];
  uncertainties: Uncertainty[];
  recommendedViews: ArtifactSpec[];
};

/** Final output of a research task. */
export type ResearchResult = {
  topic: string;
  report: string;
  notes: ResearchNote[];
  sources: { title: string; url: string }[];
  messages: AgentMessage[];
  /** Resolved task mode (auto-classified unless overridden via params.mode). */
  mode: TaskMode;
  /** Claim-level citation verification result, if it ran. */
  verification?: VerificationSnapshot;
  /** Structured explanation model used for constrained generated UI artifacts. */
  explanation?: ExplanationModel;
};

/** Per-result snapshot of the claim-verification pass(es). */
export type VerificationSnapshot = {
  attempts: number;
  /** Summary of the most recent verification attempt. */
  passRate: number;
  total: number;
  supported: number;
  unsupported: number;
  status: "passed" | "failed" | "no_claims";
  reason?: string;
  /**
   * Whether the LATEST verification attempt fell below threshold (i.e. the final
   * report would still trigger a rewrite if the loop hadn't been capped). False when
   * the final attempt passed, even if earlier attempts triggered rewrites that
   * fixed the report.
   */
  rewriteTriggered: boolean;
};
