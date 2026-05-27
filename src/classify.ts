// ABOUTME: Pre-planning task classifier — labels a research prompt as lookup, extraction, or synthesis
// ABOUTME: so downstream prompts and stop-conditions can switch behavior. LLM call is injectable for tests.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "./config.js";

/** Task modes the research loop adapts to. */
export const TASK_MODES = ["lookup", "extraction", "synthesis", "survey"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

const TASK_MODE_SET = new Set<string>(TASK_MODES);

const CLASSIFY_TIMEOUT_MS = 20_000;

/**
 * Survey mode is gated until it's been validated against real prompts.
 * Set RESEARCHER_SURVEY_MODE_ENABLED=true to let the classifier emit / upgrade to survey.
 */
export function isSurveyModeEnabled(): boolean {
  return process.env.RESEARCHER_SURVEY_MODE_ENABLED === "true";
}

/** Signature for the classifier LLM call. Injectable so tests can avoid real LLM calls. */
export type ModeClassifier = (topic: string) => Promise<string | null>;

const CLASSIFY_SYSTEM = [
  "You classify a research request into one of four modes.",
  "",
  "  lookup     — the user wants one specific fact (a number, name, date, entity).",
  "  extraction — the user wants several exact values from a primary source (filing, dataset, paper, report).",
  "  survey     — the user wants exhaustive enumeration of a research space: a literature review, 'state of X',",
  "               landscape, benchmark survey, or comparison across many systems / papers / benchmarks.",
  "  synthesis  — the user wants a structured analysis, argument, plan, or overview of a focused question.",
  "",
  "Rules:",
  "  • If the prompt names a single entity and asks 'what is / when / who / how much / X = ?', use lookup.",
  "  • If the prompt names a document/dataset and asks for tabular/numeric data, use extraction.",
  "  • If the prompt asks to 'identify all / survey / review the landscape of / what benchmarks-systems-papers exist'",
  "    across a field, use survey. Survey wants breadth: many named items enumerated, not one focused argument.",
  "  • If the prompt asks for explanation, comparison of a few things, advice, or a focused report, use synthesis.",
  "  • When uncertain between extraction and synthesis, prefer extraction if numbers are central.",
  "  • When uncertain between survey and synthesis, prefer survey if the prompt asks to enumerate a whole field.",
  "",
  "Output exactly one word on a single line: lookup | extraction | survey | synthesis. No explanation, no JSON.",
].join("\n");

/** Default classifier — calls the utility LLM with a strict single-word output prompt. */
export const defaultClassifier: ModeClassifier = async (topic: string) => {
  const model = getUtilityModel();
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const message = await completeSimple(
      model,
      {
        systemPrompt: CLASSIFY_SYSTEM,
        messages: [
          { role: "user" as const, content: `Research request: ${topic}`, timestamp: Date.now() },
        ],
      },
      {
        maxTokens: 8,
        apiKey: getEnvApiKey(model.provider),
        reasoning: getUtilityReasoning(),
        signal: controller.signal,
      },
    );
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  } finally {
    clearTimeout(timerId);
  }
};

/** Parse a free-form LLM response into a canonical TaskMode, or null. */
export function parseClassification(raw: string | null | undefined): TaskMode | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (TASK_MODE_SET.has(trimmed)) return trimmed as TaskMode;
  // Look for the first canonical word anywhere in the response.
  const match = trimmed.match(/\b(lookup|extraction|synthesis|survey)\b/);
  return match ? (match[1] as TaskMode) : null;
}

/**
 * Heuristic: does this prompt clearly ask for an exhaustive survey of a research
 * space rather than a focused synthesis? Two-signal rule, mirroring the extraction
 * heuristic: a survey-intent verb (survey / review / landscape / identify-all /
 * state-of) PLUS an enumeration target (benchmarks, systems, papers, literature,
 * tools, methods, frameworks, metrics, datasets, approaches).
 *
 * Requiring two signals avoids upgrading a focused synthesis prompt that merely
 * says "review the evidence" or mentions "systems" in passing.
 */
export function hasSurveySignals(topic: string): boolean {
  const t = topic.toLowerCase();

  const surveyVerbs = [
    "survey", "literature review", "state of the", "state of ",
    "landscape", "identify relevant", "identify all", "identify the",
    "what are all", "comprehensive overview", "map the", "taxonomy of",
    "review of", "review the", "catalog", "enumerate",
  ];
  const hasSurveyVerb = surveyVerbs.some((w) => t.includes(w));

  const enumerationTargets = [
    "benchmark", "benchmarks", "systems", "papers", "literature",
    "tools", "methods", "frameworks", "metrics", "datasets",
    "approaches", "techniques", "models", "algorithms", "protocols",
  ];
  // Require at least two distinct enumeration targets, OR one target plus an
  // explicit "and gaps / and metrics" research-space framing. A single target
  // alone ("review the systems") is too weak.
  const matchedTargets = enumerationTargets.filter((w) => t.includes(w));

  return hasSurveyVerb && matchedTargets.length >= 2;
}

/**
 * Heuristic: does this prompt have strong signals it's an extraction task that
 * the LLM may have under-classified as synthesis? Two-stage check:
 *
 *   filing-words (10-K, 10-Q, 8-K, filing, prospectus, dataset, etc.)
 *   + extract-verbs (extract, calculate, determine, compute, pull) OR
 *     numeric-period markers (Q1 2024, fiscal 2025) WITH at least one filing word.
 *
 * Requiring two distinct signals avoids upgrading synthesis prompts that
 * happen to mention "2024" or "calculate the impact".
 */
export function hasExtractionSignals(topic: string): boolean {
  const t = topic.toLowerCase();

  const filingWords = [
    "10-k", "10k", "10-q", "10q", "8-k", "8k",
    "def 14a", "proxy statement", "prospectus", "s-1",
    "filing", "filings", "edgar", "sec filing",
    "balance sheet", "income statement", "cash flow statement",
    "fiscal year", "fiscal q", "annual report", "quarterly report",
  ];
  const hasFilingWord = filingWords.some((w) => t.includes(w));

  const extractVerbs = [
    "extract", "calculate", "compute", "determine ", "pull ",
    "tabulate", "list every", "for each", "line by line",
  ];
  const hasExtractVerb = extractVerbs.some((w) => t.includes(w));

  // Period markers — quarter + year, fiscal + year, "from Q1 2024 to Q1 2025", etc.
  const periodMarker = /\bq[1-4]\s*\d{4}\b|\bfiscal\s*(q[1-4]|\d{4}|year)\b|\bfy\s*\d{2,4}\b/.test(t);

  // Two-signal rule. Filing-word alone isn't enough (a synthesis prompt could
  // mention "10-K" casually); we want filing-word AND something extractive.
  if (hasFilingWord && (hasExtractVerb || periodMarker)) return true;
  // Extract-verb AND period-marker also qualifies, even without the literal filing word.
  if (hasExtractVerb && periodMarker) return true;
  return false;
}

/** Classify a research topic. Defaults to "synthesis" on failure or unrecognized output. */
export async function classifyTask(opts: {
  topic: string;
  classifier?: ModeClassifier;
}): Promise<TaskMode> {
  const classifier = opts.classifier ?? defaultClassifier;
  let llmMode: TaskMode | null = null;
  try {
    const raw = await classifier(opts.topic);
    llmMode = parseClassification(raw);
  } catch {
    llmMode = null;
  }
  let baseMode = llmMode ?? "synthesis";

  // Survey mode is gated. When disabled, never let the LLM's survey verdict
  // through — fall back to synthesis so behavior is unchanged from before.
  const surveyEnabled = isSurveyModeEnabled();
  if (baseMode === "survey" && !surveyEnabled) {
    baseMode = "synthesis";
  }

  // Heuristic override: if the LLM under-classified to synthesis but the
  // prompt clearly asks for extraction, upgrade. Never override lookup or
  // extraction outright — only push synthesis up to extraction.
  if (baseMode === "synthesis" && hasExtractionSignals(opts.topic)) {
    return "extraction";
  }

  // Heuristic override: push synthesis up to survey when the prompt clearly
  // asks to enumerate a whole research space (gated). Extraction wins over
  // survey when both fire, since exact-value extraction is the narrower intent.
  if (baseMode === "synthesis" && surveyEnabled && hasSurveySignals(opts.topic)) {
    return "survey";
  }

  return baseMode;
}
