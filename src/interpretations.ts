// ABOUTME: Standalone interpretation generator — produces literal + lateral readings of a
// ABOUTME: question up front so the redundant fan-out can assign one reading per worker.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "./config.js";
import type { PlanInterpretation } from "./types.js";

const TIMEOUT_MS = 30_000;

/** Injectable completion fn (a plain prompt -> text), so generation is testable without LLM. */
export type CompleteFn = (prompt: string) => Promise<string>;

const SYSTEM = [
  "You decompose a research question into distinct READINGS before any searching.",
  "Always include the literal reading. Then add lateral readings only when the wording plausibly hides another meaning:",
  "homophone (sounds like), pun, anagram, paraphrase, reference (cultural/brand/work), descriptor, association.",
  "Each reading must be genuinely different — a different thing to go search for, not a rephrase.",
  "",
  'Output exactly JSON: {"interpretations":[{"reading":"literal"|"lateral","device"?:string,"meaning":string,"queriesTarget"?:string}]}.',
  "No prose, no preamble.",
].join("\n");

/**
 * Generate candidate readings of `question`. The fan-out assigns one reading per worker, so
 * surfacing a lateral reading here (e.g. the "bubble gum" -> "Bubba Gump" homophone) is what
 * lets a dedicated worker pursue it without a lone reasoner self-rejecting it. Always returns
 * at least the literal reading so the caller can run at least one angle.
 */
export async function generateInterpretations(
  question: string,
  opts: { complete?: CompleteFn } = {},
): Promise<PlanInterpretation[]> {
  const deterministic = deterministicInterpretations(question);
  const complete = opts.complete ?? defaultComplete;
  let text = "";
  try {
    text = await complete(`Question: ${question}\n\nOutput JSON only.`);
  } catch {
    text = "";
  }
  const parsed = parseInterpretations(text);
  return dedupeInterpretations(ensureLiteral(question, [...deterministic, ...parsed]));
}

function parseInterpretations(text: string): PlanInterpretation[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { interpretations?: unknown };
    if (!Array.isArray(obj.interpretations)) return [];
    return obj.interpretations.flatMap((item) => normalizeInterpretation(item));
  } catch {
    return [];
  }
}

function normalizeInterpretation(item: unknown): PlanInterpretation[] {
  if (!item || typeof item !== "object") return [];
  const v = item as { reading?: unknown; device?: unknown; meaning?: unknown; queriesTarget?: unknown };
  if (typeof v.meaning !== "string" || !v.meaning.trim()) return [];
  const reading = v.reading === "lateral" ? "lateral" : "literal";
  return [
    {
      reading,
      meaning: v.meaning,
      ...(typeof v.device === "string" ? { device: v.device } : {}),
      ...(typeof v.queriesTarget === "string" ? { queriesTarget: v.queriesTarget } : {}),
    },
  ];
}

function ensureLiteral(question: string, interps: PlanInterpretation[]): PlanInterpretation[] {
  if (interps.some((i) => i.reading === "literal")) return interps;
  return [{ reading: "literal", meaning: `Take the question at face value: ${question}`, queriesTarget: question }, ...interps];
}

function deterministicInterpretations(question: string): PlanInterpretation[] {
  const quoted = Array.from(question.matchAll(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => !!value);
  const out: PlanInterpretation[] = [];
  for (const phrase of quoted) {
    out.push({
      reading: "literal",
      meaning: `The quoted phrase "${phrase}" appears literally in the target answer or source wording.`,
      queriesTarget: `${phrase} ${question.replace(phrase, "").trim()}`.trim(),
    });
    const phonetic = phoneticVariants(phrase);
    if (phonetic.length > 0) {
      out.push({
        reading: "lateral",
        device: "homophone",
        meaning: `The quoted phrase "${phrase}" may be a sound-alike clue rather than literal wording.`,
        queriesTarget: `${phonetic.join(" OR ")} ${question.replace(phrase, "").trim()}`.trim(),
      });
    }
  }
  return out;
}

function phoneticVariants(phrase: string): string[] {
  const normalized = phrase.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const variants = new Set<string>();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const joined = words.join(" ");
  variants.add(joined);

  // Generic-ish sound-alike substitutions that often appear in clues and brand names.
  const substitutions: Array<[RegExp, string]> = [
    [/\bbubble\b/g, "bubba"],
    [/\bble\b/g, "bba"],
    [/\bgum\b/g, "gump"],
    [/\bforrest\b/g, "forest"],
    [/\bforest\b/g, "forrest"],
    [/\bto\b/g, "two"],
    [/\btwo\b/g, "to"],
    [/\btoo\b/g, "two"],
    [/\bsee\b/g, "sea"],
    [/\bsea\b/g, "see"],
    [/\bwon\b/g, "one"],
    [/\bone\b/g, "won"],
  ];
  for (const [pattern, replacement] of substitutions) {
    const next = joined.replace(pattern, replacement);
    if (next !== joined) variants.add(next);
  }

  // Also try replacing inside words, which catches bubble -> bubba.
  const inside = joined
    .replace(/\bbubble\b/g, "bubba")
    .replace(/ble\b/g, "bba")
    .replace(/\bgum\b/g, "gump");
  if (inside !== joined) variants.add(inside);

  variants.delete(joined);
  return [...variants].slice(0, 6);
}

function dedupeInterpretations(interps: PlanInterpretation[]): PlanInterpretation[] {
  const seen = new Set<string>();
  const out: PlanInterpretation[] = [];
  for (const interp of interps) {
    const key = `${interp.reading}|${interp.device ?? ""}|${interp.meaning}|${interp.queriesTarget ?? ""}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(interp);
  }
  return out;
}

const defaultComplete: CompleteFn = async (prompt) => {
  const model = getUtilityModel();
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const message = await completeSimple(
      model,
      { systemPrompt: SYSTEM, messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }] },
      { maxTokens: 800, apiKey: getEnvApiKey(model.provider), reasoning: getUtilityReasoning(), signal: controller.signal },
    );
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  } finally {
    clearTimeout(timerId);
  }
};
