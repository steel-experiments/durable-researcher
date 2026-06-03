// ABOUTME: Post-synthesis completeness critic for team/subagent research runs.
// ABOUTME: One LLM pass that names coverage gaps the fan-out missed, to fight agentic laziness.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "../config.js";

const CRITIC_TIMEOUT_MS = 60_000;
const CRITIC_MAX_TOKENS = 700;
/** Each objective is truncated to this many chars in the prompt to bound token cost. */
const OBJECTIVE_PREVIEW_CHARS = 280;
/** Upper bound on gaps surfaced — keeps the artifact and any follow-up actionable. */
const MAX_GAPS = 12;

export type CompletenessCritique = {
  /** True when the critic judged the report adequately covers the objectives. */
  coverageComplete: boolean;
  /** Concrete missing angles, unverified claims, or uncovered modalities. */
  gaps: string[];
};

/** Injectable critic call. Returns a verdict, or null to signal "no usable judgment". */
export type CompletenessCritic = (input: {
  topic: string;
  report: string;
  objectives: string[];
}) => Promise<{ coverageComplete: boolean; gaps: string[] } | null>;

const CRITIC_SYSTEM = [
  "You audit a finished research report for COMPLETENESS, not correctness.",
  "Given the topic, the planned research angles, and the final report, identify what is MISSING:",
  "  • Planned angles that are absent or thinly covered.",
  "  • Substantive claims stated without a citation or evidence.",
  "  • Obvious perspectives, data modalities, or counter-views a thorough report would include.",
  "",
  "Be specific and actionable — each gap should name what is missing, not vaguely gesture at it.",
  "Do not invent flaws; if coverage is genuinely thorough, say so with an empty gap list.",
  "",
  `Output exactly one JSON object: {"coverageComplete": boolean, "gaps": string[]}. No prose, no preamble.`,
].join("\n");

/** Default critic — one constrained utility-LLM call. */
export const defaultCompletenessCritic: CompletenessCritic = async ({ topic, report, objectives }) => {
  const model = getUtilityModel();
  const objectiveList = objectives.length
    ? objectives.map((o, i) => `  ${i + 1}. ${o.slice(0, OBJECTIVE_PREVIEW_CHARS)}`).join("\n")
    : "  (none provided)";
  const userPrompt = [
    `Topic: ${topic}`,
    "",
    "Planned research angles:",
    objectiveList,
    "",
    "Final report:",
    report,
    "",
    "Output JSON only.",
  ].join("\n");

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), CRITIC_TIMEOUT_MS);
  try {
    const message = await completeSimple(
      model,
      {
        systemPrompt: CRITIC_SYSTEM,
        messages: [{ role: "user" as const, content: userPrompt, timestamp: Date.now() }],
      },
      {
        maxTokens: CRITIC_MAX_TOKENS,
        apiKey: getEnvApiKey(model.provider),
        reasoning: getUtilityReasoning(),
        signal: controller.signal,
      },
    );
    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return parseCriticVerdict(text);
  } finally {
    clearTimeout(timerId);
  }
};

function parseCriticVerdict(
  text: string,
): { coverageComplete: boolean; gaps: string[] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { coverageComplete?: unknown; gaps?: unknown };
    const gaps = Array.isArray(obj.gaps)
      ? obj.gaps.filter((g): g is string => typeof g === "string")
      : [];
    return { coverageComplete: obj.coverageComplete === true, gaps };
  } catch {
    return null;
  }
}

/**
 * Critique a synthesized report's coverage. Never throws and never blocks: a missing
 * report is flagged, and a critic failure degrades to "complete with no gaps" so it can
 * only ever add information, not stall the run. The result is meant to be recorded as an
 * artifact (and, later, optionally drive a follow-up fan-out round).
 */
export async function critiqueCompleteness(opts: {
  topic: string;
  report: string;
  objectives: string[];
  critic?: CompletenessCritic;
}): Promise<CompletenessCritique> {
  if (!opts.report.trim()) {
    return { coverageComplete: false, gaps: ["No final report was produced to assess."] };
  }
  const critic = opts.critic ?? defaultCompletenessCritic;
  let verdict: Awaited<ReturnType<CompletenessCritic>> = null;
  try {
    verdict = await critic({ topic: opts.topic, report: opts.report, objectives: opts.objectives });
  } catch {
    verdict = null;
  }
  if (!verdict) return { coverageComplete: true, gaps: [] };
  const gaps = verdict.gaps.map((g) => g.trim()).filter(Boolean).slice(0, MAX_GAPS);
  return { coverageComplete: verdict.coverageComplete, gaps };
}
