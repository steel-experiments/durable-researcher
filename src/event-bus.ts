// ABOUTME: Typed in-process event bus for live research progress.
// ABOUTME: The persister emits events here; TUI subscribers render them as findings, status, and report.

import type { ResearchNote } from "./types.js";
import type { UsageStats } from "./durable-turns.js";

/** Discriminated union of all events emitted during a research run. */
export type ResearchEvent =
  | { type: "turn-start"; turn: number; sources: number; maxSources: number; maxTurns: number }
  | { type: "tool-start"; toolCallId: string; toolName: string; argSummary: string }
  /** `summary` is a short, human-readable result digest (e.g. "5 new", "3.2KB"). */
  | {
      type: "tool-end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      summary: string;
    }
  | { type: "browse-added"; url: string }
  | { type: "note-added"; note: ResearchNote; index: number }
  | { type: "agent-text"; delta: string }
  | { type: "report-text"; text: string }
  | { type: "usage-update"; usage: UsageStats }
  // Coarse-grained phase descriptor for the status line ("Loading checkpoint…",
  // "Starting worker…", etc.). Independent of `tool-start` / `turn-start` so the
  // TUI can keep narrating *between* agent events — useful on resume, where
  // replay is silent and no AgentEvent fires until the next live turn.
  | { type: "agent-status"; text: string }
  // Bulk snapshot of rebuilt state on resume. Fired once after the persister
  // finishes loading checkpointed messages — lets the TUI populate the findings
  // pane and counters even when no new agent turn runs (e.g. fully-completed
  // task being re-claimed for finalization).
  | { type: "snapshot"; turn: number; sources: number; notes: ResearchNote[] }
  // Coarse-grained pipeline phase. `research` covers the agent loop. `verifying` runs
  // claim verification. `rewriting` runs a citation-fix turn. `complete` is terminal.
  // The TUI uses this to label the AGENT line so the user knows what's happening
  // between the research turn ending and the report being saved (verify-claims +
  // rewrite together take minutes; without a phase signal the TUI looks frozen).
  | {
      type: "phase";
      phase: "research" | "verifying" | "rewriting" | "complete";
    }
  // Outcome of one citation-verification attempt. `willRewrite` indicates whether the
  // agent will follow up with a rewrite turn (pass rate < threshold).
  | {
      type: "verification-result";
      attempt: number;
      passRate: number;
      supported: number;
      total: number;
      threshold: number;
      willRewrite: boolean;
      status?: "passed" | "failed" | "no_claims";
      reason?: string;
    }
  | { type: "task-complete" }
  | { type: "task-error"; message: string };

export type ResearchEventHandler = (event: ResearchEvent) => void;

export type ResearchEventBus = {
  subscribe(handler: ResearchEventHandler): () => void;
  emit(event: ResearchEvent): void;
};

/**
 * Sink for one-line progress strings from tools (plan/prefetch/scout).
 * Returning `undefined` from the factory means "log straight to stdout"
 * — used in non-TUI mode where direct console.log is fine.
 *
 * In TUI mode the strings get folded into `agent-status` events instead, so
 * they update the status line rather than ripping through ink's render.
 */
export type ToolProgress = (text: string) => void;

/** Build the progress sink appropriate for the current mode. */
export function createToolProgress(bus?: ResearchEventBus): ToolProgress {
  if (!bus) {
    return (text: string) => console.log(text);
  }
  return (text: string) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed.length > 0) bus.emit({ type: "agent-status", text: trimmed });
  };
}

/** Create an in-process event bus with FIFO delivery and isolated subscriber errors. */
export function createResearchEventBus(): ResearchEventBus {
  const handlers = new Set<ResearchEventHandler>();

  return {
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(event) {
      // Snapshot subscribers so unsubscribes during dispatch don't affect this round.
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (err) {
          console.error(
            `[event-bus] subscriber threw on ${event.type}:`,
            (err as Error).message,
          );
        }
      }
    },
  };
}
