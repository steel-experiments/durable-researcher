// ABOUTME: gap_analysis tool — names entities a thorough report should cover but that are missing from current notes.
// ABOUTME: Drives a self-critique fill loop in survey/synthesis modes; call budget is bounded per run.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "../config.js";
import type { ResearchNote } from "../types.js";
import type { ToolProgress } from "../event-bus.js";

const GapParams = Type.Object({});

/** A named entity the report should cover but that isn't yet represented in the notes. */
export type GapEntity = { name: string; kind: string; why?: string };

/** Injectable LLM call so tests can avoid real network calls. */
export type GapAnalyzer = (topic: string, notesDigest: string) => Promise<string | null>;

const GAP_TIMEOUT_MS = 45_000;

/** Max entities surfaced per call — keep the follow-up workload bounded. */
const MAX_GAP_ENTITIES = 10;

/** Build a compact digest of what the notes already cover, for the analyzer to compare against. */
export function buildNotesDigest(notes: ResearchNote[]): string {
  if (notes.length === 0) return "(no notes recorded yet)";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const n of notes) {
    const key = n.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${n.title}: ${n.content.slice(0, 120)}`);
  }
  return lines.join("\n");
}

const GAP_SYSTEM = [
  "You audit a research notebook for coverage gaps.",
  "",
  "Given a research TOPIC and a digest of NOTES already collected, list the named entities a thorough,",
  "exhaustive report on this topic should cover but that are NOT yet represented in the notes.",
  "Named entities are concrete: specific systems, tools, products, papers, benchmarks, datasets,",
  "organizations, people, or named metrics — never vague themes like 'more recent work'.",
  "",
  "Rules:",
  `  • Return at most ${MAX_GAP_ENTITIES} entities, the highest-value missing ones first.`,
  "  • Only list entities you are reasonably confident exist and are relevant to the topic.",
  "  • If coverage already looks complete, return an empty array.",
  "  • Do NOT repeat anything already present in the notes digest.",
  "",
  "Output ONLY a JSON array, no prose. Each element:",
  '  { "name": "<entity name>", "kind": "system|paper|benchmark|person|org|metric", "why": "<one short reason it matters>" }',
].join("\n");

/** Default analyzer — calls the utility LLM. */
export const defaultGapAnalyzer: GapAnalyzer = async (topic, notesDigest) => {
  const model = getUtilityModel();
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), GAP_TIMEOUT_MS);
  try {
    const message = await completeSimple(
      model,
      {
        systemPrompt: GAP_SYSTEM,
        messages: [
          {
            role: "user" as const,
            content: `TOPIC: ${topic}\n\nNOTES:\n${notesDigest}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 800,
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

/** Parse the analyzer's JSON-array response into structured entities. Robust to junk around the array. */
export function parseGapEntities(raw: string | null | undefined): GapEntity[] {
  if (!raw) return [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: GapEntity[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const name = typeof (item as any).name === "string" ? (item as any).name.trim() : "";
    if (!name) continue;
    const kind = typeof (item as any).kind === "string" ? (item as any).kind.trim() : "unknown";
    const why = typeof (item as any).why === "string" ? (item as any).why.trim() : undefined;
    out.push({ name, kind, ...(why ? { why } : {}) });
    if (out.length >= MAX_GAP_ENTITIES) break;
  }
  return out;
}

/**
 * Create a gap_analysis tool. Surfaces missing named entities so the agent can fill
 * coverage holes before synthesizing. Bounded to `maxCalls` invocations per run to
 * prevent infinite "find more gaps" loops.
 */
export function createGapAnalysisTool(opts: {
  notes: ResearchNote[];
  topic: string;
  maxCalls: number;
  analyzer?: GapAnalyzer;
  progress?: ToolProgress;
}): AgentTool<typeof GapParams> {
  const analyze = opts.analyzer ?? defaultGapAnalyzer;
  const report = opts.progress ?? ((text: string) => console.log(text));
  let callsUsed = 0;

  return {
    name: "gap_analysis",
    label: "Gap Analysis",
    description:
      "Audit your current notes for coverage gaps. Returns named entities (systems, papers, benchmarks, orgs, metrics) " +
      "a thorough report should cover but that you haven't recorded yet. Call this before submit_report to catch holes. " +
      "Then use find_entity or scout to fill the gaps it surfaces. Bounded budget — use it deliberately.",
    parameters: GapParams,
    execute: async () => {
      if (callsUsed >= opts.maxCalls) {
        return {
          content: [
            {
              type: "text" as const,
              text: `gap_analysis budget exhausted (used ${callsUsed}/${opts.maxCalls}). Do not call it again — synthesize your report now using the notes you have.`,
            },
          ],
          details: { callsUsed, maxCalls: opts.maxCalls, entities: [], exhausted: true },
        };
      }
      callsUsed++;

      const digest = buildNotesDigest(opts.notes);
      let entities: GapEntity[] = [];
      try {
        const raw = await analyze(opts.topic, digest);
        entities = parseGapEntities(raw);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `gap_analysis failed (${(err as Error).message}). Proceed with your current notes — either scout for obvious gaps or synthesize.`,
            },
          ],
          details: { callsUsed, maxCalls: opts.maxCalls, entities: [], error: true },
        };
      }

      report(`    [GAP] ${entities.length} missing entit${entities.length === 1 ? "y" : "ies"} (call ${callsUsed}/${opts.maxCalls})`);

      if (entities.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `gap_analysis found no missing entities — coverage looks complete. Synthesize your report now.`,
            },
          ],
          details: { callsUsed, maxCalls: opts.maxCalls, entities: [] },
        };
      }

      const lines = [
        `## Coverage gaps (call ${callsUsed}/${opts.maxCalls})`,
        `These named entities are likely relevant but missing from your ledger. Use \`find_entity\` (fast, entity-targeted) or \`scout\` to cover each, then \`record_claims\`. Skip any that are genuinely out of scope.`,
        ``,
        ...entities.map(
          (e) => `- **${e.name}** (${e.kind})${e.why ? ` — ${e.why}` : ""}`,
        ),
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { callsUsed, maxCalls: opts.maxCalls, entities },
      };
    },
  };
}
