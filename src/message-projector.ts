// ABOUTME: Projects agent messages into durable research state.
// ABOUTME: Shared by resume replay and live event handling so tool-result semantics stay aligned.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResearchNote } from "./types.js";

export type MessageProjection = {
  notes: ResearchNote[];
  scrapedUrls: Set<string>;
};

export type MessageProjectionDelta = {
  noteAdded?: { note: ResearchNote; index: number };
  /** Direct browse_url result only. Batch tools update state but do not emit UI browse events. */
  browseAdded?: string;
};

type ProjectionInternals = {
  noteCalls: Map<string, ResearchNote>;
  browseCalls: Map<string, string>;
};

export type MessageProjector = MessageProjection & ProjectionInternals;

export function createMessageProjector(initial?: {
  notes?: ResearchNote[];
  scrapedUrls?: Set<string>;
}): MessageProjector {
  return {
    notes: initial?.notes ?? [],
    scrapedUrls: initial?.scrapedUrls ?? new Set<string>(),
    noteCalls: new Map<string, ResearchNote>(),
    browseCalls: new Map<string, string>(),
  };
}

export function projectMessage(
  projector: MessageProjector,
  msg: AgentMessage,
): MessageProjectionDelta {
  if (!("role" in msg)) return {};

  if (msg.role === "assistant") {
    recordAssistantToolCalls(projector, msg);
    return {};
  }

  if (msg.role !== "toolResult" || msg.isError) return {};

  if (msg.toolName === "take_note") {
    const note = projector.noteCalls.get(msg.toolCallId);
    if (!note) return {};
    const index = projector.notes.length;
    projector.notes.push(note);
    return { noteAdded: { note, index } };
  }

  if (msg.toolName === "browse_url") {
    const url = projector.browseCalls.get(msg.toolCallId);
    if (!url) return {};
    projector.scrapedUrls.add(url);
    return { browseAdded: url };
  }

  if (msg.toolName === "prefetch_sources" || msg.toolName === "scout") {
    const details = msg.details as { browsedUrls?: string[] } | undefined;
    if (details?.browsedUrls) {
      for (const url of details.browsedUrls) projector.scrapedUrls.add(url);
    }
  }

  return {};
}

export function projectMessages(messages: AgentMessage[]): MessageProjection {
  const projector = createMessageProjector();
  for (const msg of messages) projectMessage(projector, msg);
  return {
    notes: projector.notes,
    scrapedUrls: projector.scrapedUrls,
  };
}

function recordAssistantToolCalls(
  projector: MessageProjector,
  msg: Extract<AgentMessage, { role: "assistant" }>,
): void {
  for (const content of msg.content) {
    if (content.type !== "toolCall") continue;

    if (content.name === "take_note") {
      const args = content.arguments as {
        title: string;
        content: string;
        sourceUrls: string[];
        confidence: "high" | "medium" | "low";
        keyExcerpts?: string[];
      };
      projector.noteCalls.set(content.id, {
        title: args.title,
        content: args.content,
        sourceUrls: args.sourceUrls,
        confidence: args.confidence,
        ...(args.keyExcerpts?.length ? { keyExcerpts: args.keyExcerpts } : {}),
      });
    } else if (content.name === "browse_url") {
      const args = content.arguments as { url: string };
      projector.browseCalls.set(content.id, args.url);
    }
  }
}
