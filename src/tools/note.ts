// ABOUTME: take_note tool — lets the agent record structured research findings.
// ABOUTME: Notes are stored in-memory and rebuilt from replayed messages on resume.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResearchNote } from "../types.js";
import { deduplicateNotes } from "../notes-ranker.js";

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
});

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
      const note: ResearchNote = {
        title: params.title,
        content: params.content,
        sourceUrls: params.sourceUrls,
        confidence: params.confidence,
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
