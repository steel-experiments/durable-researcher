// ABOUTME: take_note tool — lets the agent record structured research findings.
// ABOUTME: Notes are stored in-memory and rebuilt from replayed messages on resume.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResearchNote } from "../types.js";

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

      return {
        content: [
          {
            type: "text" as const,
            text: `Note recorded: "${note.title}" (${note.confidence} confidence, ${note.sourceUrls.length} sources). Total notes: ${notes.length}.`,
          },
        ],
        details: { noteIndex: notes.length - 1 },
      };
    },
  };
}
