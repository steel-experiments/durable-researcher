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
  /** Fraction of claims that were supported. 0 when total is 0. */
  passRate: number;
  /**
   * Machine-readable status for downstream policy. `no_claims` means the report
   * did not contain parseable numeric inline citations, so no claim was actually
   * verified.
   */
  status: "passed" | "failed" | "no_claims";
  reason?: string;
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
const SECTION_HEADING_RE = /^#{2,3}\s+(.+)$/gm;
const MIN_UNCITED_SECTION_WORDS = 20;

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

function reportBody(report: string): string {
  const sourcesMatch = report.match(SOURCES_HEADING_RE);
  return sourcesMatch?.index !== undefined
    ? report.slice(0, sourcesMatch.index)
    : report;
}

function hasNumericCitation(text: string): boolean {
  CITATION_RE.lastIndex = 0;
  return CITATION_RE.test(text);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Identify substantial report sections that contain no numeric inline citations.
 * This is a structural validation step, not LLM claim verification: a report can
 * cite some facts while still leaving whole sections unauditable.
 */
export function findUncitedSubstantiveSections(report: string): string[] {
  const body = reportBody(report);
  const headings = [...body.matchAll(SECTION_HEADING_RE)];
  if (headings.length === 0) {
    return wordCount(body) >= MIN_UNCITED_SECTION_WORDS && !hasNumericCitation(body)
      ? ["Report body"]
      : [];
  }

  const out: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const title = heading[1].trim();
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[i + 1]?.index ?? body.length;
    const section = body.slice(start, end);
    if (wordCount(section) < MIN_UNCITED_SECTION_WORDS) continue;
    if (hasNumericCitation(section)) continue;
    out.push(title);
  }
  return out;
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
  if (total === 0) {
    return {
      total: 0,
      supported: 0,
      unsupported: 0,
      passRate: 0,
      status: "no_claims",
      reason: "No parseable numeric inline citations were found in the report body",
    };
  }
  const passRate = supported / total;
  return {
    total,
    supported,
    unsupported: total - supported,
    passRate,
    status: passRate >= VERIFY_PASS_THRESHOLD ? "passed" : "failed",
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
  if (parsed.length > 0) {
    for (const section of findUncitedSubstantiveSections(opts.report)) {
      claims.push({
        claim: `Section "${section}" contains substantive text without numeric inline citations.`,
        sourceN: 0,
        sourceUrl: null,
        supported: false,
        reason: "Substantive report section has no numeric inline citations",
      });
    }
  }

  return { claims, summary: computeVerificationSummary(claims) };
}

/**
 * Verifier calibration. Prior wording was "Be strict: 'related topic discussed'
 * is NOT support" — that ran ~30-37% pass rate on survey-density reports because
 * fine-grained bibliographic claims (X is a Y benchmark from year Z) get rejected
 * even when the source plainly states all three facts in slightly different
 * wording. The new wording asks for semantic equivalence with bright-line
 * rejection cases. Don't flip back to strict without re-running validation.
 */
const VERIFY_SYSTEM = [
  "You verify whether a single CLAIM is supported by QUOTES from one source.",
  "",
  "The claim is SUPPORTED when a reasonable reader of the quotes would agree the source backs it — paraphrase and reordering are fine; what matters is whether the underlying facts overlap.",
  "",
  "Examples that ARE supported:",
  `  • Claim: "OSWorld has 369 tasks." Quote: "OSWorld provides 369 real-world computer tasks across operating systems." → supported (same fact, different framing).`,
  `  • Claim: "Claude Opus 4.6 leads OSWorld at 72.7%." Quote: "Anthropic's Claude Opus 4.6 leads with 72.7%." → supported (the agent and the score both appear).`,
  `  • Claim: "τ-bench tests tool-agent-user interaction in customer-service domains." Quote: "τ-bench: a benchmark for tool-agent-user interaction in retail and airline domains." → supported (customer-service is a fair gloss of retail+airline).`,
  `  • Claim: "AgentBench evaluates LLMs across multiple environments." Quote: "AgentBench is the first multi-dimensional evaluation suite for LLM-as-Agent across 8 distinct environments." → supported (multiple = 8).`,
  "",
  "Examples that are NOT supported:",
  `  • Claim: "The agent achieves 91% accuracy." Quote: "The agent performs well on the benchmark." → not supported (no number).`,
  `  • Claim: "The paper was published at CHI 2024." Quote: "Recently presented at a workshop." → not supported (specific venue missing).`,
  `  • Claim: "X is faster than Y." Quote: "X and Y are both web agents." → not supported (no comparison).`,
  "",
  "Reject only when one of these holds:",
  "  (a) The quotes are silent on the claim's specific fact (no factual overlap), OR",
  "  (b) The quotes contradict the claim, OR",
  "  (c) The claim adds a specific number, date, name, or attribution the quotes don't contain.",
  "",
  "Be reasonable, not pedantic. A claim that captures the substance of a quote in slightly different words is supported.",
  "",
  `Output exactly one JSON object: {"supported": boolean, "reason": string}. No prose, no preamble.`,
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
  if (result.summary.total === 0) return true;
  return result.summary.passRate < VERIFY_PASS_THRESHOLD;
}

/**
 * Strict ordering on verification quality, used by the rewrite loop's regression
 * guard: a rewrite that ends up "no_claims" (stripped to a meta-acknowledgement)
 * must lose against any prior attempt that had real claims, even if that prior
 * attempt's pass rate was poor. Otherwise compare by supported count, then by
 * pass rate as a tiebreaker.
 */
export function isBetterVerification(a: VerificationResult, b: VerificationResult): boolean {
  const aNoClaims = a.summary.status === "no_claims";
  const bNoClaims = b.summary.status === "no_claims";
  if (aNoClaims !== bNoClaims) return !aNoClaims; // a is better iff it has claims and b doesn't
  if (a.summary.supported !== b.summary.supported) return a.summary.supported > b.summary.supported;
  return a.summary.passRate > b.summary.passRate;
}

/**
 * A claim is "ungrounded" when the cited source has no excerpts at all — either it
 * was never browsed, browsing failed, or the source number is missing from the
 * Sources section. Ungrounded claims cannot be salvaged by re-wording; the only
 * correct move is to delete them and remove the dangling Sources entry.
 *
 * "Unsupported" claims, in contrast, cite a real browsed source that has excerpts —
 * the LLM verifier just judged the specific assertion as not backed by those
 * excerpts. Those can be softened or re-cited.
 */
const UNGROUNDED_REASON_MARKERS = [
  "No excerpts recorded for this source",
  "Cited source [",
];

function isUngroundedFailure(c: ClaimVerification): boolean {
  return UNGROUNDED_REASON_MARKERS.some((marker) => c.reason.includes(marker));
}

/** Build a steering message that asks the agent to rewrite the report. */
export function buildRewriteSteering(result: VerificationResult): string {
  const failed = result.claims.filter((c) => !c.supported);
  const thresholdPct = (VERIFY_PASS_THRESHOLD * 100).toFixed(0);

  if (result.summary.total === 0) {
    return [
      `[SYSTEM] Citation verification: 0/0 claims supported (0%, threshold ${thresholdPct}%).`,
      ``,
      `No parseable numeric inline citations were found in the report body.`,
      ``,
      `Rewrite the report so every factual claim that depends on evidence uses numeric inline citations such as [1] or [2].`,
      `Do NOT replace numeric citations with markdown author links like [(Author, 2024)](https://example.com).`,
      `Every entry in the Sources section MUST be a URL you actually browsed in this session — if you can't ground a claim to a browsed source, delete the claim.`,
      ``,
      `Keep everything else intact. Do NOT call any tools. Just write the corrected report.`,
    ].join("\n");
  }

  const ungrounded = failed.filter(isUngroundedFailure);
  const unsupported = failed.filter((c) => !isUngroundedFailure(c));
  const ungroundedSourceNs = [...new Set(ungrounded.map((c) => c.sourceN))].sort((a, b) => a - b);

  const lines = [
    `[SYSTEM] Citation verification: ${result.summary.supported}/${result.summary.total} claims supported (${(result.summary.passRate * 100).toFixed(0)}%, threshold ${thresholdPct}%).`,
    ``,
    `MANDATORY rewrite rules — follow each exactly, do not negotiate:`,
    ``,
  ];

  lines.push(
    `The report's structure is good — keep ALL its sections, tables, and well-grounded claims. Only touch the specific claims listed below. Do NOT strip the report to a meta-acknowledgement; produce a full report with citations intact.`,
    ``,
  );

  if (ungroundedSourceNs.length > 0) {
    lines.push(
      `Source(s) [${ungroundedSourceNs.join("], [")}] have NO recorded excerpts (not browsed or browsing failed). For each:`,
      `  1. For every claim citing one of these sources: either remove just that sentence, or re-cite it to a different already-browsed source whose excerpts back it.`,
      `  2. Remove those entries from the Sources section.`,
      `  3. Renumber the remaining Sources sequentially (1, 2, 3, …) and update every [n] marker in the body to match.`,
      ``,
      `Examples of claims to fix (delete the sentence OR re-cite to a browsed source):`,
      ...ungrounded.slice(0, 6).map((c) => `  • "${c.claim}" (cites [${c.sourceN}])`),
      ``,
    );
  }

  if (unsupported.length > 0) {
    lines.push(
      `The following claims cite a browsed source, but the excerpts do not back the specific assertion:`,
      ``,
      ...unsupported.slice(0, 10).map((c, i) =>
        `  ${i + 1}. Cites [${c.sourceN}] (${c.sourceUrl ?? "no URL"}): "${c.claim}"\n     Reason: ${c.reason}`,
      ),
      ``,
      `For each, do EXACTLY ONE of:`,
      `  - Soften the claim to what the excerpts actually say (do not invent specifics).`,
      `  - Re-cite a different already-browsed source whose excerpts back it.`,
      `  - Delete just that sentence.`,
      `Do NOT re-cite the same source unchanged — the verifier will reject it again.`,
      ``,
    );
  }

  lines.push(
    `Use numeric inline citations only, such as [1] or [2]. Do NOT use markdown author links.`,
    `Every numbered entry in the Sources section MUST be a URL you actually browsed in this session.`,
    ``,
    `Keep everything else intact. Do NOT call any tools. Just write the corrected report.`,
  );
  return lines.join("\n");
}
