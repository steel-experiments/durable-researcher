// ABOUTME: Second independent synthesis pass over the claim ledger.
// ABOUTME: Diffs an independently synthesized ledger view against the submitted report.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getUtilityModel, getUtilityReasoning } from "./config.js";
import type { ResearchLedger } from "./types.js";

export type SynthesisAuditIssue = {
  type: "missing" | "contradiction" | "overclaim";
  claim: string;
  reason: string;
};

export type SynthesisAuditResult = {
  independentSynthesis: string;
  issues: SynthesisAuditIssue[];
  needsRewrite: boolean;
};

const AUDIT_TIMEOUT_MS = 60_000;

export function buildLedgerDigest(ledger: ResearchLedger): string {
  const lines: string[] = [];
  lines.push("Required claims:");
  for (const required of ledger.requiredClaims) {
    lines.push(`- ${required.id} [${required.status}]: ${required.question}`);
  }
  lines.push("");
  lines.push("Ledger claims:");
  for (const claim of ledger.claims) {
    lines.push(
      `- ${claim.id} [${claim.status}; ${claim.confidence}; independent=${claim.independentCorroboration}]: ${claim.text}`,
    );
    const links = ledger.evidenceLinks.filter((link) => link.claimId === claim.id);
    for (const link of links.slice(0, 6)) {
      const excerpt = ledger.excerpts.find((item) => item.id === link.excerptId)?.text ?? "";
      lines.push(
        `  - ${link.supports ? "supports" : "contradicts"}; ${link.tier}; ${link.publishedAt ?? "undated"}; ${link.sourceUrl}; "${excerpt.slice(0, 240)}"`,
      );
    }
  }
  return lines.join("\n").slice(0, 24_000);
}

export async function auditReportAgainstLedger(input: {
  topic: string;
  report: string;
  ledger: ResearchLedger;
}): Promise<SynthesisAuditResult> {
  if (input.ledger.claims.length === 0) {
    return { independentSynthesis: "", issues: [], needsRewrite: false };
  }

  const model = getUtilityModel();
  const systemPrompt = [
    "You are an independent research synthesis auditor.",
    "You receive a structured claim/evidence ledger and a submitted report.",
    "First synthesize the answer from the ledger only. Then diff that synthesis against the submitted report.",
    "Flag only material issues: missing central ledger-backed conclusions, report claims contradicted by the ledger, or overclaims stronger than ledger confidence supports.",
    'Output exactly JSON: {"independentSynthesis": string, "issues": [{"type": "missing"|"contradiction"|"overclaim", "claim": string, "reason": string}], "needsRewrite": boolean}.',
  ].join("\n");
  const userPrompt = [
    `Topic: ${input.topic}`,
    "",
    "LEDGER:",
    buildLedgerDigest(input.ledger),
    "",
    "SUBMITTED REPORT:",
    input.report.slice(0, 24_000),
  ].join("\n");

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
  try {
    const message = await completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: "user" as const, content: userPrompt, timestamp: Date.now() }],
      },
      {
        maxTokens: 1600,
        apiKey: getEnvApiKey(model.provider),
        reasoning: getUtilityReasoning(),
        signal: controller.signal,
      },
    );
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return parseSynthesisAudit(text);
  } finally {
    clearTimeout(timerId);
  }
}

export function parseSynthesisAudit(text: string): SynthesisAuditResult {
  const json = extractJsonObject(text);
  if (!json) return { independentSynthesis: "", issues: [], needsRewrite: false };
  try {
    const parsed = JSON.parse(json) as {
      independentSynthesis?: unknown;
      issues?: unknown;
      needsRewrite?: unknown;
    };
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.flatMap((item) => normalizeIssue(item))
      : [];
    return {
      independentSynthesis: typeof parsed.independentSynthesis === "string"
        ? parsed.independentSynthesis
        : "",
      issues,
      needsRewrite: typeof parsed.needsRewrite === "boolean"
        ? parsed.needsRewrite && issues.length > 0
        : issues.length > 0,
    };
  } catch {
    return { independentSynthesis: "", issues: [], needsRewrite: false };
  }
}

export function buildSynthesisAuditSteering(result: SynthesisAuditResult): string {
  const issueLines = result.issues.map((issue, index) =>
    `${index + 1}. ${issue.type}: ${issue.claim} — ${issue.reason}`,
  );
  return [
    "[SECOND SYNTHESIS AUDIT]",
    "An independent pass over the claim ledger found material differences from the submitted report.",
    "",
    "Independent synthesis:",
    result.independentSynthesis || "(not provided)",
    "",
    "Issues to reconcile:",
    ...issueLines,
    "",
    "Rewrite the final report now. Use only ledger-backed claims, explicitly report unresolved contradictions, and soften overclaims to match confidence.",
    "Do NOT call any tools. Output only the corrected report itself.",
  ].join("\n");
}

export function buildSynthesisAuditMessage(result: SynthesisAuditResult): AgentMessage {
  return {
    role: "user" as const,
    content: buildSynthesisAuditSteering(result),
    timestamp: Date.now(),
  };
}

function normalizeIssue(item: unknown): SynthesisAuditIssue[] {
  if (!item || typeof item !== "object") return [];
  const value = item as { type?: unknown; claim?: unknown; reason?: unknown };
  const type = value.type === "missing" || value.type === "contradiction" || value.type === "overclaim"
    ? value.type
    : undefined;
  if (!type || typeof value.claim !== "string" || typeof value.reason !== "string") return [];
  return [{ type, claim: value.claim, reason: value.reason }];
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
