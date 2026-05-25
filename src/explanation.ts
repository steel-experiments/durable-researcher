// ABOUTME: Builds structured explanation artifacts from durable research state.
// ABOUTME: Keeps provenance in typed data so renderers do not depend on model-authored HTML.

import type {
  ArtifactSpec,
  Claim,
  Evidence,
  EvidenceExcerpt,
  ExplanationModel,
  ExplanationSource,
  ResearchNote,
  TaskMode,
} from "./types.js";
import type { VerificationResult } from "./tools/verify-claims.js";

type VerificationState = {
  result: VerificationResult;
};

function confidenceFromSupported(supported: boolean): "high" | "low" {
  return supported ? "high" : "low";
}

function sourceIdsForUrls(sources: ExplanationSource[], urls: string[]): string[] {
  const byUrl = new Map(sources.map((source) => [source.url, source.id]));
  return urls.map((url) => byUrl.get(url)).filter((id): id is string => !!id);
}

function excerptIdsForEvidenceUrl(
  excerpts: EvidenceExcerpt[],
  evidenceId: string,
  url?: string | null,
): string[] {
  return excerpts
    .filter((excerpt) => excerpt.evidenceId === evidenceId && (!url || excerpt.sourceUrl === url))
    .map((excerpt) => excerpt.id);
}

function summarizeAnswer(report: string): string {
  const firstParagraph = report
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return firstParagraph ?? report.trim();
}

export function buildExplanationModel(input: {
  report: string;
  notes: ResearchNote[];
  mode: TaskMode;
  verification?: VerificationState;
  urlTitles?: ReadonlyMap<string, string>;
}): ExplanationModel {
  const uniqueUrls = Array.from(new Set(input.notes.flatMap((note) => note.sourceUrls)));
  const sources = uniqueUrls.map<ExplanationSource>((url, index) => ({
    id: `source-${index + 1}`,
    title: input.urlTitles?.get(url) ?? url,
    url,
  }));

  const excerpts: EvidenceExcerpt[] = [];
  const evidence = input.notes.map<Evidence>((note, noteIndex) => {
    const evidenceId = `evidence-${noteIndex + 1}`;
    const excerptIds: string[] = [];
    for (const [excerptIndex, text] of (note.keyExcerpts ?? []).entries()) {
      const id = `${evidenceId}-excerpt-${excerptIndex + 1}`;
      excerptIds.push(id);
      excerpts.push({
        id,
        evidenceId,
        text,
        ...(note.sourceUrls.length === 1 ? { sourceUrl: note.sourceUrls[0] } : {}),
      });
    }
    return {
      id: evidenceId,
      title: note.title,
      content: note.content,
      sourceUrls: note.sourceUrls,
      excerptIds,
      confidence: note.confidence,
    };
  });

  const claims = input.verification?.result.claims.length
    ? input.verification.result.claims.map<Claim>((claim, index) => {
        const matchedEvidence = evidence.filter((item) =>
          claim.sourceUrl ? item.sourceUrls.includes(claim.sourceUrl) : false,
        );
        const evidenceIds = matchedEvidence.map((item) => item.id);
        return {
          id: `claim-${index + 1}`,
          text: claim.claim,
          sourceUrls: claim.sourceUrl ? [claim.sourceUrl] : [],
          evidenceIds,
          excerptIds: matchedEvidence.flatMap((item) =>
            excerptIdsForEvidenceUrl(excerpts, item.id, claim.sourceUrl),
          ),
          confidence: confidenceFromSupported(claim.supported),
          verification: {
            supported: claim.supported,
            reason: claim.reason,
          },
        };
      })
    : evidence.map<Claim>((item, index) => ({
        id: `claim-${index + 1}`,
        text: item.content,
        sourceUrls: item.sourceUrls,
        evidenceIds: [item.id],
        excerptIds: item.excerptIds,
        confidence: item.confidence,
      }));

  const uncertainties = [
    ...evidence
      .filter((item) => item.confidence === "low")
      .map((item, index) => ({
        id: `uncertainty-low-confidence-${index + 1}`,
        description: `Low-confidence note: ${item.title}`,
        severity: "medium" as const,
        evidenceIds: [item.id],
      })),
    ...claims
      .filter((claim) => claim.verification && !claim.verification.supported)
      .map((claim, index) => ({
        id: `uncertainty-unsupported-claim-${index + 1}`,
        description: claim.verification?.reason ?? `Unsupported claim: ${claim.text}`,
        severity: "high" as const,
        evidenceIds: claim.evidenceIds,
      })),
  ];

  const recommendedViews: ArtifactSpec[] = [];
  if (input.mode === "extraction") {
    recommendedViews.push({
      kind: "extraction_evidence_table",
      title: "Evidence Table",
      rows: evidence.map((item) => ({
        id: `row-${item.id}`,
        label: item.title,
        confidence: item.confidence,
        sourceIds: sourceIdsForUrls(sources, item.sourceUrls),
        evidenceIds: [item.id],
        excerptIds: item.excerptIds,
        missingFields: [
          ...(item.sourceUrls.length === 0 ? ["source URL"] : []),
          ...(item.excerptIds.length === 0 ? ["verbatim excerpt"] : []),
        ],
      })),
    });
  }

  return {
    answer: summarizeAnswer(input.report),
    claims,
    evidence,
    excerpts,
    sources,
    reasoningSteps: evidence.map((item, index) => ({
      id: `step-${index + 1}`,
      title: item.title,
      content: item.content,
      evidenceIds: [item.id],
    })),
    uncertainties,
    recommendedViews,
  };
}
