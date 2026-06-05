// ABOUTME: Builds structured explanation artifacts from durable research state.
// ABOUTME: Keeps provenance in typed data so renderers do not depend on model-authored HTML.

import type {
  ArtifactSpec,
  Claim,
  Evidence,
  EvidenceExcerpt,
  ExtractionEvidenceTableRow,
  ExplanationModel,
  ExplanationSource,
  ResearchNote,
  TaskMode,
} from "./types.js";
import { parseSourcesSection, type VerificationResult } from "./tools/verify-claims.js";

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
  const analysisMatch = report.match(/^##\s+Analysis\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  const analysisParagraph = analysisMatch?.[1]
    ?.split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith("|"));
  if (analysisParagraph) return analysisParagraph;

  const paragraphs = report
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const answer = paragraphs.find((part) =>
    !part.startsWith("#") &&
    !part.startsWith("|") &&
    !part.startsWith("**Note") &&
    !part.includes("\n|") &&
    !/^[-*]\s/.test(part),
  );
  return answer ?? paragraphs.find((part) => !part.startsWith("#")) ?? report.trim();
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function normalizeConfidence(value: string): "high" | "medium" | "low" {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("low")) return "low";
  if (normalized.includes("medium") || normalized.includes("med")) return "medium";
  return "high";
}

function sourceNumbersFromCell(value: string): number[] {
  return [...value.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function extractMarkdownEvidenceTableRows(input: {
  report: string;
  sources: ExplanationSource[];
  evidence: Evidence[];
  excerpts: EvidenceExcerpt[];
}): ExtractionEvidenceTableRow[] | null {
  const lines = input.report.split("\n");
  const headingIndex = lines.findIndex((line) => /^#{2,3}\s+Evidence Table\s*$/i.test(line.trim()));
  if (headingIndex < 0) return null;

  const tableStart = lines.findIndex((line, index) =>
    index > headingIndex && line.trim().startsWith("|"),
  );
  if (tableStart < 0 || tableStart + 1 >= lines.length) return null;

  const tableLines: string[] = [];
  for (let i = tableStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) break;
    tableLines.push(line);
  }
  if (tableLines.length < 3) return null;

  const headers = parseMarkdownTableRow(tableLines[0]);
  const separator = parseMarkdownTableRow(tableLines[1]);
  if (!separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;

  const sourceUrlByNumber = parseSourcesSection(input.report);
  const sourceIdByUrl = new Map(input.sources.map((source) => [source.url, source.id]));
  const evidenceByUrl = new Map<string, Evidence[]>();
  for (const item of input.evidence) {
    for (const url of item.sourceUrls) {
      evidenceByUrl.set(url, [...(evidenceByUrl.get(url) ?? []), item]);
    }
  }
  const excerptsByEvidenceId = new Map<string, EvidenceExcerpt[]>();
  for (const excerpt of input.excerpts) {
    excerptsByEvidenceId.set(excerpt.evidenceId, [
      ...(excerptsByEvidenceId.get(excerpt.evidenceId) ?? []),
      excerpt,
    ]);
  }

  const sourceColumn = headers.findIndex((header) => header.toLowerCase() === "source");
  const confidenceColumn = headers.findIndex((header) => header.toLowerCase() === "confidence");
  const metricColumn = headers.findIndex((header) => ["metric", "field", "finding"].includes(header.toLowerCase()));

  const rows = tableLines.slice(2).map((line, rowIndex) => {
    const cells = parseMarkdownTableRow(line);
    const sourceNumbers = sourceColumn >= 0 ? sourceNumbersFromCell(cells[sourceColumn] ?? "") : [];
    const sourceUrls = sourceNumbers
      .map((n) => sourceUrlByNumber.get(n))
      .filter((url): url is string => !!url);
    const matchedEvidence = sourceUrls.flatMap((url) => evidenceByUrl.get(url) ?? []);
    const evidenceIds = Array.from(new Set(matchedEvidence.map((item) => item.id)));
    const excerptIds = Array.from(new Set(matchedEvidence.flatMap((item) =>
      excerptsByEvidenceId.get(item.id)?.map((excerpt) => excerpt.id) ?? [],
    )));
    const confidence = normalizeConfidence(confidenceColumn >= 0 ? cells[confidenceColumn] ?? "" : "");
    const fields = headers
      .map((header, index) => ({ label: header, value: cells[index] ?? "" }))
      .filter((field, index) =>
        field.value.length > 0 &&
        index !== metricColumn &&
        index !== sourceColumn &&
        index !== confidenceColumn &&
        field.label !== "#",
      );
    const missingFields = [
      ...(sourceUrls.length === 0 ? ["source URL"] : []),
      ...(excerptIds.length === 0 ? ["verbatim excerpt"] : []),
      ...(confidence !== "high" ? ["high-confidence support"] : []),
    ];

    return {
      id: `row-extraction-${rowIndex + 1}`,
      label: metricColumn >= 0 ? cells[metricColumn] ?? `Row ${rowIndex + 1}` : `Row ${rowIndex + 1}`,
      fields,
      confidence,
      sourceIds: sourceUrls.map((url) => sourceIdByUrl.get(url)).filter((id): id is string => !!id),
      evidenceIds,
      excerptIds,
      missingFields,
    };
  });

  return rows.length > 0 ? rows : null;
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
        // A claim may cite several sources (OR semantics); match evidence whose URLs
        // intersect any cited source.
        const matchedEvidence = evidence.filter((item) =>
          claim.sourceUrls.some((url) => item.sourceUrls.includes(url)),
        );
        const evidenceIds = matchedEvidence.map((item) => item.id);
        return {
          id: `claim-${index + 1}`,
          text: claim.claim,
          sourceUrls: claim.sourceUrls,
          evidenceIds,
          excerptIds: matchedEvidence.flatMap((item) =>
            claim.sourceUrls.flatMap((url) => excerptIdsForEvidenceUrl(excerpts, item.id, url)),
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

  const rawUncertainties = [
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
  const seenUncertainty = new Set<string>();
  const uncertainties = rawUncertainties.filter((item) => {
    const key = item.description.trim().toLowerCase();
    if (!key || seenUncertainty.has(key)) return false;
    seenUncertainty.add(key);
    return true;
  });

  const recommendedViews: ArtifactSpec[] = [];
  if (input.mode === "extraction") {
    const parsedRows = extractMarkdownEvidenceTableRows({
      report: input.report,
      sources,
      evidence,
      excerpts,
    });
    recommendedViews.push({
      kind: "extraction_evidence_table",
      title: "Evidence Table",
      rows: parsedRows ?? evidence.map((item) => ({
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
