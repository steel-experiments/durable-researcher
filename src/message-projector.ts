// ABOUTME: Projects agent messages into durable research state.
// ABOUTME: Shared by resume replay and live event handling so tool-result semantics stay aligned.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResearchLedger, ResearchNote, ResearchPlan } from "./types.js";
import {
  createResearchLedger,
  ledgerToNotes,
  recordClaimsInLedger,
  setRequiredClaims,
  type RecordClaimInput,
} from "./ledger.js";
import { addVisitedUrl } from "./url-normalize.js";

export type MessageProjection = {
  notes: ResearchNote[];
  ledger: ResearchLedger;
  scrapedUrls: Set<string>;
};

export type MessageProjectionDelta = {
  noteAdded?: { note: ResearchNote; index: number };
  notesAdded?: Array<{ note: ResearchNote; index: number }>;
  /** Direct browse_url result only. Batch tools update state but do not emit UI browse events. */
  browseAdded?: string;
};

type ProjectionInternals = {
  recordClaimCalls: Map<string, RecordClaimInput[]>;
  browseCalls: Map<string, string>;
};

export type MessageProjector = MessageProjection & ProjectionInternals;

export function createMessageProjector(initial?: {
  notes?: ResearchNote[];
  ledger?: ResearchLedger;
  scrapedUrls?: Set<string>;
}): MessageProjector {
  return {
    notes: initial?.notes ?? [],
    ledger: initial?.ledger ?? createResearchLedger(),
    scrapedUrls: initial?.scrapedUrls ?? new Set<string>(),
    recordClaimCalls: new Map<string, RecordClaimInput[]>(),
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

  if (msg.toolName === "record_claims") {
    const entries = projector.recordClaimCalls.get(msg.toolCallId);
    if (!entries) return {};
    const previousCount = projector.notes.length;
    recordClaimsInLedger(projector.ledger, entries);
    projector.notes.length = 0;
    projector.notes.push(...ledgerToNotes(projector.ledger));
    return {
      notesAdded: projector.notes
        .slice(previousCount)
        .map((note, offset) => ({ note, index: previousCount + offset })),
    };
  }

  if (msg.toolName === "plan_research") {
    const plan = msg.details as ResearchPlan | undefined;
    setRequiredClaims(projector.ledger, plan?.requiredClaims);
  }

  if (msg.toolName === "browse_url") {
    const url = projector.browseCalls.get(msg.toolCallId);
    if (!url) return {};
    const details = msg.details as { meaningful?: boolean } | undefined;
    if (details?.meaningful === false) return {};
    addVisitedUrl(projector.scrapedUrls, url);
    return { browseAdded: url };
  }

  if (msg.toolName === "prefetch_sources" || msg.toolName === "scout") {
    const details = msg.details as {
      browsedUrls?: string[];
      meaningfulBrowsedUrls?: string[];
    } | undefined;
    const urls = details?.meaningfulBrowsedUrls ?? details?.browsedUrls;
    if (urls) {
      for (const url of urls) addVisitedUrl(projector.scrapedUrls, url);
    }
  }

  return {};
}

export function projectMessages(messages: AgentMessage[]): MessageProjection {
  const projector = createMessageProjector();
  for (const msg of messages) projectMessage(projector, msg);
  return {
    notes: projector.notes,
    ledger: projector.ledger,
    scrapedUrls: projector.scrapedUrls,
  };
}

function recordAssistantToolCalls(
  projector: MessageProjector,
  msg: Extract<AgentMessage, { role: "assistant" }>,
): void {
  for (const content of msg.content) {
    if (content.type !== "toolCall") continue;

    if (content.name === "record_claims") {
      const args = content.arguments as { claims?: RecordClaimInput[] };
      projector.recordClaimCalls.set(content.id, args.claims ?? []);
    } else if (content.name === "browse_url") {
      const args = content.arguments as { url: string };
      projector.browseCalls.set(content.id, args.url);
    }
  }
}
