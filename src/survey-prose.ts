// ABOUTME: Constrained LLM pass that unifies a survey's prose sections from concatenated subagent prose.
// ABOUTME: Generation-from-evidence only — never touches tables or sources; falls back to the concat on failure.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "./config.js";
import type { SurveyMergeParts } from "./survey-merge.js";

const SYNTH_TIMEOUT_MS = 60_000;
const SYNTH_MAX_TOKENS = 1600;
/** A refined section must beat this fraction of the concat length to be trusted (anti-collapse). */
const MIN_LENGTH_RATIO = 0.15;
/** Absolute floor — anything shorter is a degenerate/meta response, reject it. */
const MIN_ABSOLUTE_CHARS = 200;

/** Injectable synthesizer call. Returns unified prose for one section, or null to keep the concat. */
export type ProseSynthesizer = (input: {
  section: string;
  concatenatedBody: string;
  entities: string[];
}) => Promise<string | null>;

function buildSystemPrompt(section: string): string {
  return [
    `You unify one section of a research survey: "${section}".`,
    "",
    "You receive that section's text as written independently by several subagents, concatenated",
    "under '### From Subagent N' headers. Rewrite them into ONE coherent section with no per-subagent",
    "headers, merging overlapping points and keeping distinct ones.",
    "",
    "HARD RULES:",
    "  • Preserve every numeric inline citation marker exactly as written, e.g. [3] or [5, 12]. Do not renumber.",
    "  • Do NOT invent citations, facts, systems, or numbers not present in the input.",
    "  • Output ONLY the section body in markdown (you may use ### sub-headings for themes). No '## heading',",
    "    no tables, no Sources list, no preamble, no meta-commentary about the rewrite.",
    "  • This is a substantial section of a long survey — keep it comprehensive. Do not over-compress.",
  ].join("\n");
}

/** Default synthesizer — one constrained utility-LLM call per section. */
export const defaultProseSynthesizer: ProseSynthesizer = async ({ section, concatenatedBody, entities }) => {
  const model = getUtilityModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
  try {
    const entityHint = entities.length
      ? `\n\nEntities covered elsewhere in this survey (for reference; cite only what the text below supports):\n${entities.slice(0, 60).join(", ")}`
      : "";
    const message = await completeSimple(
      model,
      {
        systemPrompt: buildSystemPrompt(section),
        messages: [
          { role: "user" as const, content: `${concatenatedBody}${entityHint}`, timestamp: Date.now() },
        ],
      },
      {
        maxTokens: SYNTH_MAX_TOKENS,
        apiKey: getEnvApiKey(model.provider),
        reasoning: getUtilityReasoning(),
        signal: controller.signal,
      },
    );
    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    return text || null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Refine the prose sections of a merged survey. For each section, calls the synthesizer
 * and accepts its output only if it's substantial (anti-collapse guard) — otherwise the
 * deterministic concat is kept. Returns a section→prose override map for assembleSurvey.
 * Never throws: any per-section failure falls back to the concat.
 */
export async function refineSurveyProse(
  parts: SurveyMergeParts,
  synthesizer: ProseSynthesizer = defaultProseSynthesizer,
): Promise<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const { section, body } of parts.prose) {
    try {
      const refined = await synthesizer({ section, concatenatedBody: body, entities: parts.entities });
      if (isAcceptable(refined, body)) overrides[section] = refined!.trim();
    } catch {
      // Keep the concat for this section.
    }
  }
  return overrides;
}

/** Guard against the collapse failure mode: reject short/degenerate refinements. */
function isAcceptable(refined: string | null, concat: string): boolean {
  if (!refined) return false;
  const trimmed = refined.trim();
  if (trimmed.length < MIN_ABSOLUTE_CHARS) return false;
  if (trimmed.length < concat.length * MIN_LENGTH_RATIO) return false;
  // Reject obvious meta-acknowledgements.
  if (/^(the (report|section) (has been|is now)|i have (rewritten|unified|merged))/i.test(trimmed)) return false;
  return true;
}
