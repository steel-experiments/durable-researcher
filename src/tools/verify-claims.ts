// ABOUTME: Claim-level citation verification — parses [n] markers in the report and
// ABOUTME: checks each against the cited source's key excerpts via the utility LLM.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "../config.js";
import type { ResearchNote } from "../types.js";

/** Default pass-rate threshold below which we trigger one rewrite. */
export const VERIFY_PASS_THRESHOLD = 0.7;

/** Max claims verified in parallel. */
export const VERIFY_CONCURRENCY = 4;

/** Timeout in ms for a single claim-verification LLM call. */
const VERIFY_TIMEOUT_MS = 30_000;

export type ParsedClaim = {
  /** The sentence containing the citation. */
  text: string;
  /** The source number referenced in the citation marker. */
  sourceN: number;
};

export type ClaimVerification = {
  claim: string;
  sourceN: number;
  sourceUrl: string | null;
  supported: boolean;
  reason: string;
};

export type VerificationSummary = {
  total: number;
  supported: number;
  unsupported: number;
  /** Fraction of claims that were supported. 1 when total is 0. */
  passRate: number;
};

export type VerificationResult = {
  claims: ClaimVerification[];
  summary: VerificationSummary;
};

/** Signature for a single-claim verifier. Injectable for tests. */
export type ClaimVerifier = (input: {
  claim: string;
  excerpts: string[];
  sourceUrl: string;
}) => Promise<{ supported: boolean; reason: string }>;

const SOURCES_HEADING_RE = /^#{1,3}\s*Sources\b/im;
const NEXT_HEADING_RE = /^#{1,3}\s+\S/m;
const CITATION_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const BARE_URL_RE = /(https?:\/\/[^\s)]+)/;
const NUMBERED_LINE_RE = /^\s*(\d+)\.\s+(.+)$/;

/** Parse the "## Sources" or "### Sources" section into a map of N → URL. */
export function parseSourcesSection(report: string): Map<number, string> {
  const map = new Map<number, string>();
  const match = report.match(SOURCES_HEADING_RE);
  if (!match || match.index === undefined) return map;

  const afterHeading = report.slice(match.index + match[0].length);
  const nextHeading = afterHeading.match(NEXT_HEADING_RE);
  const section = nextHeading?.index !== undefined
    ? afterHeading.slice(0, nextHeading.index)
    : afterHeading;

  for (const line of section.split("\n")) {
    const numbered = line.match(NUMBERED_LINE_RE);
    if (!numbered) continue;
    const n = Number.parseInt(numbered[1], 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    const rest = numbered[2];
    const linkMatch = rest.match(MARKDOWN_LINK_RE);
    const url = linkMatch ? linkMatch[2] : rest.match(BARE_URL_RE)?.[1];
    if (url) map.set(n, url.replace(/[).,]+$/, ""));
  }
  return map;
}

/** Parse [n] and [n, m] markers from the body (everything before the Sources section). */
export function parseCitations(report: string): ParsedClaim[] {
  const sourcesMatch = report.match(SOURCES_HEADING_RE);
  const body = sourcesMatch?.index !== undefined
    ? report.slice(0, sourcesMatch.index)
    : report;

  const claims: ParsedClaim[] = [];
  CITATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(body)) !== null) {
    const numbers = m[1]
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (numbers.length === 0) continue;
    const sentence = extractSentenceAround(body, m.index, m.index + m[0].length);
    if (!sentence) continue;
    for (const n of numbers) claims.push({ text: sentence, sourceN: n });
  }
  return claims;
}

function extractSentenceAround(
  text: string,
  citationStart: number,
  citationEnd: number,
): string {
  let start = 0;
  for (let i = citationStart - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n" && i > 0 && text[i - 1] === "\n") {
      start = i + 1;
      break;
    }
    if (
      (ch === "." || ch === "!" || ch === "?") &&
      i + 1 < text.length &&
      (text[i + 1] === " " || text[i + 1] === "\n")
    ) {
      start = i + 1;
      break;
    }
  }

  let end = text.length;
  for (let i = citationEnd; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" && i + 1 < text.length && text[i + 1] === "\n") {
      end = i;
      break;
    }
    if (
      (ch === "." || ch === "!" || ch === "?") &&
      (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\n")
    ) {
      end = i + 1;
      break;
    }
  }

  return text.slice(start, end).trim();
}

/** Find all unique excerpts from notes whose sourceUrls include the given URL. */
export function excerptsForSource(
  notes: ResearchNote[],
  url: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const note of notes) {
    if (!note.sourceUrls.includes(url)) continue;
    if (!note.keyExcerpts?.length) continue;
    for (const ex of note.keyExcerpts) {
      const key = ex.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(ex);
    }
  }
  return out;
}

/**
 * Return the effective excerpts for `url`: note excerpts when any note explicitly lists
 * the URL, otherwise the fallback excerpts captured during browsing. The fallback fixes
 * the citation-attribution gap where a corroborating URL was browsed but never added to
 * a note's sourceUrls.
 */
export function effectiveExcerptsForSource(
  notes: ResearchNote[],
  url: string,
  urlExcerpts?: ReadonlyMap<string, string[]>,
): string[] {
  const fromNotes = excerptsForSource(notes, url);
  if (fromNotes.length > 0) return fromNotes;
  return urlExcerpts?.get(url) ?? [];
}

export function computeVerificationSummary(
  claims: ClaimVerification[],
): VerificationSummary {
  const total = claims.length;
  const supported = claims.filter((c) => c.supported).length;
  return {
    total,
    supported,
    unsupported: total - supported,
    passRate: total === 0 ? 1 : supported / total,
  };
}

/** Run a small async pool: up to `concurrency` tasks at once. */
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const n = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/** Verify all citations in a report against the notes' key excerpts. */
export async function verifyClaims(opts: {
  report: string;
  notes: ResearchNote[];
  verifier?: ClaimVerifier;
  concurrency?: number;
  signal?: AbortSignal;
  /**
   * Fallback excerpts keyed by URL, captured during browsing. Used to ground citations
   * to URLs that no note explicitly lists in its sourceUrls — the citation-attribution
   * failure mode where the model browsed corroborating URL A but only attached URL B to
   * the note.
   */
  urlExcerpts?: ReadonlyMap<string, string[]>;
}): Promise<VerificationResult> {
  const verifier = opts.verifier ?? defaultClaimVerifier;
  const concurrency = opts.concurrency ?? VERIFY_CONCURRENCY;
  const sourceMap = parseSourcesSection(opts.report);
  const parsed = parseCitations(opts.report);

  const claims = await pMap(parsed, concurrency, async ({ text, sourceN }) => {
    opts.signal?.throwIfAborted();
    const url = sourceMap.get(sourceN) ?? null;
    if (!url) {
      return {
        claim: text,
        sourceN,
        sourceUrl: null,
        supported: false,
        reason: `Cited source [${sourceN}] not found in the report's Sources section`,
      } satisfies ClaimVerification;
    }
    const excerpts = effectiveExcerptsForSource(opts.notes, url, opts.urlExcerpts);
    if (excerpts.length === 0) {
      return {
        claim: text,
        sourceN,
        sourceUrl: url,
        supported: false,
        reason: "No excerpts recorded for this source — cannot ground the claim",
      } satisfies ClaimVerification;
    }
    try {
      const verdict = await verifier({ claim: text, excerpts, sourceUrl: url });
      return {
        claim: text,
        sourceN,
        sourceUrl: url,
        supported: verdict.supported,
        reason: verdict.reason,
      } satisfies ClaimVerification;
    } catch (err) {
      return {
        claim: text,
        sourceN,
        sourceUrl: url,
        supported: false,
        reason: `Verifier error: ${(err as Error).message}`,
      } satisfies ClaimVerification;
    }
  });

  return { claims, summary: computeVerificationSummary(claims) };
}

const VERIFY_SYSTEM = [
  "You verify whether a single claim is supported by verbatim quotes from one source.",
  "Read the claim and the quotes. Decide:",
  "  supported=true   if the quotes directly state, imply, or quantify the claim",
  "  supported=false  if the quotes are silent on the claim, contradict it, or only loosely relate",
  "Be strict: 'related topic discussed' is NOT support. A claim is supported only if a quote substantiates it.",
  "Output exactly one JSON object: {\"supported\": boolean, \"reason\": string}. No prose, no preamble.",
].join("\n");

/** Default verifier — calls the utility LLM with a tight JSON-output prompt. */
export const defaultClaimVerifier: ClaimVerifier = async ({
  claim,
  excerpts,
  sourceUrl,
}) => {
  const model = getUtilityModel();
  const userPrompt = [
    `Claim: ${claim}`,
    "",
    `Source: ${sourceUrl}`,
    "Verbatim quotes from the source:",
    ...excerpts.map((e, i) => `  ${i + 1}. "${e}"`),
    "",
    "Output JSON only.",
  ].join("\n");

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const message = await completeSimple(
      model,
      {
        systemPrompt: VERIFY_SYSTEM,
        messages: [
          { role: "user" as const, content: userPrompt, timestamp: Date.now() },
        ],
      },
      {
        maxTokens: 256,
        apiKey: getEnvApiKey(model.provider),
        reasoning: getUtilityReasoning(),
        signal: controller.signal,
      },
    );
    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const parsed = parseJsonVerdict(text);
    return parsed ?? { supported: false, reason: "Could not parse verifier output" };
  } finally {
    clearTimeout(timerId);
  }
};

function parseJsonVerdict(
  text: string,
): { supported: boolean; reason: string } | null {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as {
      supported?: unknown;
      reason?: unknown;
    };
    if (typeof obj.supported !== "boolean") return null;
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    return { supported: obj.supported, reason };
  } catch {
    return null;
  }
}

/** Decide whether a verification result warrants triggering a rewrite. */
export function shouldTriggerRewrite(result: VerificationResult): boolean {
  if (result.summary.total === 0) return false;
  return result.summary.passRate < VERIFY_PASS_THRESHOLD;
}

/** Build a steering message that asks the agent to rewrite the report. */
export function buildRewriteSteering(result: VerificationResult): string {
  const failed = result.claims.filter((c) => !c.supported);
  const lines = [
    `[SYSTEM] Citation verification: ${result.summary.supported}/${result.summary.total} claims supported (${(result.summary.passRate * 100).toFixed(0)}%, threshold ${(VERIFY_PASS_THRESHOLD * 100).toFixed(0)}%).`,
    ``,
    `The following claims could NOT be supported by their cited sources:`,
    ``,
    ...failed.slice(0, 10).map((c, i) =>
      `${i + 1}. Claim cites [${c.sourceN}] (${c.sourceUrl ?? "no URL"}):\n   "${c.claim}"\n   Reason: ${c.reason}`,
    ),
    ``,
    `Rewrite the report. For each failed claim, either:`,
    `  - Re-cite a source whose excerpts actually support it`,
    `  - Soften the claim to what the source actually says`,
    `  - Remove the claim if no source supports it`,
    ``,
    `Keep everything else intact. Do NOT call any tools. Just write the corrected report.`,
  ];
  return lines.join("\n");
}
