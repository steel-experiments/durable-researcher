// ABOUTME: Pre-planning task classifier — labels a research prompt as lookup, extraction, or synthesis
// ABOUTME: so downstream prompts and stop-conditions can switch behavior. LLM call is injectable for tests.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "./config.js";

/** Three task modes the research loop adapts to. */
export const TASK_MODES = ["lookup", "extraction", "synthesis"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

const TASK_MODE_SET = new Set<string>(TASK_MODES);

const CLASSIFY_TIMEOUT_MS = 20_000;

/** Signature for the classifier LLM call. Injectable so tests can avoid real LLM calls. */
export type ModeClassifier = (topic: string) => Promise<string | null>;

const CLASSIFY_SYSTEM = [
  "You classify a research request into one of three modes.",
  "",
  "  lookup     — the user wants one specific fact (a number, name, date, entity).",
  "  extraction — the user wants several exact values from a primary source (filing, dataset, paper, report).",
  "  synthesis  — the user wants a structured analysis, comparison, plan, or overview.",
  "",
  "Rules:",
  "  • If the prompt names a single entity and asks 'what is / when / who / how much / X = ?', use lookup.",
  "  • If the prompt names a document/dataset and asks for tabular/numeric data, use extraction.",
  "  • If the prompt asks for explanation, comparison, advice, or a report, use synthesis.",
  "  • When uncertain between extraction and synthesis, prefer extraction if numbers are central.",
  "",
  "Output exactly one word on a single line: lookup | extraction | synthesis. No explanation, no JSON.",
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
  const match = trimmed.match(/\b(lookup|extraction|synthesis)\b/);
  return match ? (match[1] as TaskMode) : null;
}

/** Classify a research topic. Defaults to "synthesis" on failure or unrecognized output. */
export async function classifyTask(opts: {
  topic: string;
  classifier?: ModeClassifier;
}): Promise<TaskMode> {
  const classifier = opts.classifier ?? defaultClassifier;
  try {
    const raw = await classifier(opts.topic);
    return parseClassification(raw) ?? "synthesis";
  } catch {
    return "synthesis";
  }
}
