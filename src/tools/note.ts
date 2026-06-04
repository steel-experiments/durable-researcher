// ABOUTME: take_note tool — lets the agent record structured research findings.
// ABOUTME: Notes are stored in-memory and rebuilt from replayed messages on resume.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResearchNote } from "../types.js";
import { MAX_EXCERPTS_PER_NOTE, MAX_EXCERPT_LENGTH } from "../types.js";
import { deduplicateNotes, capConfidenceByTier } from "../notes-ranker.js";

const NoteParams = Type.Object({
  title: Type.String({ description: "Short title for this finding" }),
  content: Type.String({
    description: "The finding itself — facts, data, quotes, analysis",
  }),
  sourceUrls: Type.Array(Type.String(), {
    description: "URLs that support this finding",
  }),
  confidence: Type.Union(
    [
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
    ],
    { description: "How confident you are in this finding" },
  ),
  keyExcerpts: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Up to 8 verbatim quotes from the source(s) supporting this finding (≤240 chars each). Required for high-confidence notes that will be cited in the final report. Capture broader coverage when the source will back multiple fine-grained claims (year, venue, metric, specific contribution).",
    }),
  ),
  sourceTier: Type.Optional(
    Type.Union(
      [
        Type.Literal("primary"),
        Type.Literal("secondary"),
        Type.Literal("blog"),
        Type.Literal("forum"),
        Type.Literal("unreliable"),
      ],
      {
        description:
          "Provenance quality of the source(s): primary (original research / institutional / official), secondary (reputable reporting), blog (individual opinion), forum (user-generated), unreliable (marketing / SEO / unverifiable). Confidence is capped to the evidence: blog→medium, forum/unreliable→low.",
      },
    ),
  ),
});

/** Sanitize excerpts: trim, drop empties, cap length, cap count. */
function sanitizeExcerpts(raw: string[] | undefined): string[] | undefined {
  if (!raw?.length) return undefined;
  const out: string[] = [];
  for (const ex of raw) {
    const trimmed = ex.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, MAX_EXCERPT_LENGTH));
    if (out.length >= MAX_EXCERPTS_PER_NOTE) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Create a take_note tool that appends to the provided notes array. */
export function createNoteTool(notes: ResearchNote[]): AgentTool<typeof NoteParams> {
  let notesSinceDedup = 0;

  return {
    name: "take_note",
    label: "Take Note",
    description:
      "Record a structured research finding with source attribution and confidence level. Use after browsing a source to distill key information.",
    parameters: NoteParams,
    execute: async (_toolCallId, params) => {
      const excerpts = sanitizeExcerpts(params.keyExcerpts);
      // Cap self-reported confidence to what the source tier can support — a note
      // can never be more confident than its evidence (forum/blog claims get demoted).
      const confidence = capConfidenceByTier(params.confidence, params.sourceTier);
      const note: ResearchNote = {
        title: params.title,
        content: params.content,
        sourceUrls: params.sourceUrls,
        confidence,
        ...(excerpts ? { keyExcerpts: excerpts } : {}),
        ...(params.sourceTier ? { sourceTier: params.sourceTier } : {}),
      };
      notes.push(note);

      // Auto-dedup periodically once notes accumulate past threshold
      const DEDUP_THRESHOLD = 8;
      const DEDUP_INTERVAL = 4;
      let mergedCount = 0;
      notesSinceDedup++;
      if (notes.length >= DEDUP_THRESHOLD && notesSinceDedup >= DEDUP_INTERVAL) {
        notesSinceDedup = 0;
        const before = notes.length;
        const deduped = deduplicateNotes(notes);
        mergedCount = before - deduped.length;
        if (mergedCount > 0) {
          notes.length = 0;
          notes.push(...deduped);
        }
      }

      const mergeMsg = mergedCount > 0
        ? ` ${mergedCount} duplicate note(s) merged.`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Note recorded: "${note.title}" (${note.confidence} confidence, ${note.sourceUrls.length} sources).${mergeMsg} Total notes: ${notes.length}.`,
          },
        ],
        details: { noteIndex: notes.length - 1, mergedCount },
      };
    },
  };
}
