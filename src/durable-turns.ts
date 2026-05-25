// ABOUTME: Bridge between Absurd step checkpoints and Pi Agent message log.
// ABOUTME: Implements the durable turns pattern: load, persist, rebuild state, and log progress.

import type { TaskContext, StepHandle } from "absurd-sdk";
import type { AgentMessage, AgentEvent } from "@mariozechner/pi-agent-core";
import type { MessageLogEntry, ResearchNote } from "./types.js";
import type { ResearchEventBus } from "./event-bus.js";

/**
 * Load the message log from checkpointed Absurd steps.
 *
 * On a fresh run, the first beginStep returns { done: false } immediately.
 * On resume after a crash, each call returns { done: true, state: {...} }
 * for previously checkpointed messages, replaying the full conversation.
 */
export async function loadMessageLog(ctx: TaskContext): Promise<{
  messages: AgentMessage[];
  nextHandle: StepHandle<MessageLogEntry>;
}> {
  const messages: AgentMessage[] = [];
  while (true) {
    const handle = await ctx.beginStep<MessageLogEntry>("message");
    if (!handle.done) {
      return { messages, nextHandle: handle };
    }
    messages.push(handle.state.message);
  }
}

/**
 * Create a message persister callback compatible with Pi Agent's AgentEventSink.
 *
 * On each message_end event:
 *   1. Complete the current step with the message
 *   2. Begin the next step slot
 *
 * The handle reference is mutated via closure so subsequent calls use the new slot.
 */
export function createMessagePersister(
  ctx: TaskContext,
  initialHandle: StepHandle<MessageLogEntry>,
): (event: AgentEvent) => Promise<void> {
  let handle = initialHandle;

  return async (event: AgentEvent) => {
    if (event.type !== "message_end") return;

    // Skip checkpointing error messages — let Absurd retry the task instead
    const msg = event.message;
    if (
      "role" in msg &&
      msg.role === "assistant" &&
      "errorMessage" in msg &&
      msg.errorMessage
    ) {
      return;
    }

    await ctx.completeStep(handle, { message: event.message });
    handle = await ctx.beginStep<MessageLogEntry>("message");
  };
}

/** Tracks token usage and costs across the run. */
export type UsageStats = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: Record<string, { input: number; output: number }>;
};

/** Tool display names for progress logging. */
const TOOL_ICONS: Record<string, string> = {
  plan_research: "[PLAN]",
  prefetch_sources: "[PREFETCH]",
  scout: "[SCOUT]",
  web_search: "[SEARCH]",
  browse_url: "[BROWSE]",
  screenshot: "[SCREENSHOT]",
  take_note: "[NOTE]",
  evaluate_progress: "[EVALUATE]",
};

/** Options for the logging persister. */
export type LoggingPersisterOptions = {
  maxSources: number;
  maxTurns: number;
  scrapedUrls: Set<string>;
  usage: UsageStats;
  eventBus?: ResearchEventBus;
  quiet?: boolean;
  /**
   * Initial turn count. When the agent invokes a second persister mid-run (e.g. for a
   * citation-rewrite turn), pass the running total so the turn counter continues from
   * where it left off instead of resetting to 0. The persister increments this on each
   * `turn_start`.
   */
  initialTurnCount?: number;
};

/**
 * Create an event sink that logs live progress, streams the final report,
 * tracks costs, and persists messages to Absurd checkpoints.
 */
export function createLoggingPersister(
  ctx: TaskContext,
  initialHandle: StepHandle<MessageLogEntry>,
  options: LoggingPersisterOptions,
): (event: AgentEvent) => Promise<void> {
  const persister = createMessagePersister(ctx, initialHandle);
  const { maxSources, maxTurns, scrapedUrls, usage, eventBus, quiet = false } = options;
  let turnCount = options.initialTurnCount ?? 0;
  let isStreamingReport = false;
  const noteCalls = new Map<string, ResearchNote>();
  const browseCalls = new Map<string, string>();

  const log = (...args: Parameters<typeof console.log>) => {
    if (!quiet) console.log(...args);
  };

  return async (event: AgentEvent) => {
    switch (event.type) {
      case "turn_start":
        turnCount++;
        eventBus?.emit({
          type: "turn-start",
          turn: turnCount,
          sources: scrapedUrls.size,
          maxSources,
          maxTurns,
        });
        log(
          `\n--- Turn ${turnCount} [${scrapedUrls.size}/${maxSources} sources${scrapedUrls.size > maxSources ? " after current batch" : ""}] [${turnCount}/${maxTurns} turns] ---`,
        );
        break;

      case "tool_execution_start": {
        const icon = TOOL_ICONS[event.toolName] ?? "[TOOL]";
        const argSummary = formatToolArgs(event.toolName, event.args);
        eventBus?.emit({
          type: "tool-start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argSummary,
        });
        log(`  ${icon} ${event.toolName}(${argSummary})`);
        // Extend lease at start of tool execution — long-running tools like
        // plan_research and prefetch_sources may take minutes without any
        // intermediate events, causing the claim timeout to expire.
        try {
          await ctx.heartbeat(300);
        } catch {
          // Heartbeat failure is not fatal
        }
        break;
      }

      case "tool_execution_end": {
        eventBus?.emit({
          type: "tool-end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          summary: summarizeToolResult(event.toolName, event.result, event.isError),
        });
        if (event.isError) {
          const icon = TOOL_ICONS[event.toolName] ?? "[TOOL]";
          log(`  ${icon} FAILED`);
        }
        // Extend lease after each tool execution to prevent timeout
        try {
          await ctx.heartbeat(300);
        } catch {
          // Heartbeat failure is not fatal
        }
        break;
      }

      case "message_update": {
        // Stream assistant text deltas — but only accumulate, don't print yet.
        // We'll print on message_end if it turns out to be the final report.
        // For now, just track deltas for the current message.
        // Forward text_delta chunks to the event bus so the TUI can show
        // "thinking…" content between tool calls. Thinking/toolcall deltas
        // are intentionally skipped — the TUI only wants user-visible text.
        const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
          .assistantMessageEvent;
        if (inner && inner.type === "text_delta" && typeof inner.delta === "string") {
          eventBus?.emit({ type: "agent-text", delta: inner.delta });
        }
        break;
      }

      case "message_end": {
        const msg = event.message;
        if ("role" in msg && msg.role === "assistant") {
          // Track usage
          if ("usage" in msg && msg.usage) {
            const u = msg.usage as {
              inputTokens?: number; input?: number;
              outputTokens?: number; output?: number;
              cacheReadInputTokens?: number; cacheRead?: number;
            };
            const input = u.inputTokens ?? u.input ?? 0;
            const output = u.outputTokens ?? u.output ?? 0;
            const cacheRead = u.cacheReadInputTokens ?? u.cacheRead ?? 0;
            usage.inputTokens += input;
            usage.outputTokens += output;
            usage.cacheReadTokens += cacheRead;

            const model = ("model" in msg ? msg.model : "unknown") as string;
            if (!usage.models[model]) {
              usage.models[model] = { input: 0, output: 0 };
            }
            usage.models[model].input += input;
            usage.models[model].output += output;
            eventBus?.emit({ type: "usage-update", usage: { ...usage, models: { ...usage.models } } });
          }

          const hasToolCalls = msg.content.some(
            (c: { type: string }) => c.type === "toolCall",
          );
          if (hasToolCalls) {
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
                noteCalls.set(content.id, {
                  title: args.title,
                  content: args.content,
                  sourceUrls: args.sourceUrls,
                  confidence: args.confidence,
                  ...(args.keyExcerpts?.length ? { keyExcerpts: args.keyExcerpts } : {}),
                });
              } else if (content.name === "browse_url") {
                const args = content.arguments as { url: string };
                browseCalls.set(content.id, args.url);
              }
            }
          }
          const textParts = msg.content.filter(
            (c): c is { type: "text"; text: string } => c.type === "text" && c.text.length > 0,
          );
          const fullText = textParts.map((c) => c.text).join("\n");

          if (!hasToolCalls && fullText.length > 500) {
            // This is the final report — print it in full
            eventBus?.emit({ type: "report-text", text: fullText });
            log("\n" + "=".repeat(80));
            log("RESEARCH REPORT");
            log("=".repeat(80) + "\n");
            log(fullText);
          } else if (hasToolCalls) {
            // Agent thinking + tool calls — show short text and tool summary
            if (fullText.length > 0 && fullText.length <= 300) {
              log(`\n  [AGENT] ${fullText}`);
            }
            const toolCalls = msg.content.filter(
              (c: { type: string }) => c.type === "toolCall",
            );
            log(`  Calling ${toolCalls.length} tool(s)...`);
          } else if (fullText.length > 0) {
            // Short non-tool text (status updates, etc.)
            log(`\n  [AGENT] ${fullText}`);
          }
        } else if ("role" in msg && msg.role === "toolResult" && !msg.isError) {
          if (msg.toolName === "take_note") {
            const note = noteCalls.get(msg.toolCallId);
            if (note) eventBus?.emit({ type: "note-added", note, index: noteCalls.size - 1 });
          } else if (msg.toolName === "browse_url") {
            const url = browseCalls.get(msg.toolCallId);
            if (url) eventBus?.emit({ type: "browse-added", url });
          }
        }
        break;
      }
    }

    // Always delegate to the checkpoint persister
    await persister(event);
  };
}

/**
 * Build a short, human-readable result digest for a tool execution.
 * Used in the live activity stream so the user can see at a glance what
 * each tool actually returned ("5 new", "ok 3.2KB", "saved", "error: ...").
 */
export function summarizeToolResult(
  toolName: string,
  result: unknown,
  isError: boolean,
): string {
  if (isError) {
    // Try to surface the first line of text content if present.
    const r = result as { content?: { type: string; text?: string }[] } | undefined;
    const text = r?.content?.find((c) => c.type === "text")?.text;
    if (text) return `error: ${text.split("\n")[0].slice(0, 80)}`;
    return "error";
  }

  const details = (result as { details?: Record<string, unknown> } | undefined)?.details;
  if (!details) return "ok";

  switch (toolName) {
    case "web_search": {
      const fresh = details.freshResults as number | undefined;
      const total = details.totalResults as number | undefined;
      if (fresh === 0) return `0 new (of ${total ?? 0})`;
      if (fresh != null && total != null) return `${fresh} new (of ${total})`;
      return "ok";
    }
    case "browse_url": {
      const meaningful = details.meaningful as boolean | undefined;
      const len = details.rawLength as number | undefined;
      if (meaningful === false) return `thin content${len ? ` (${len}b)` : ""}`;
      if (len) return `${formatBytes(len)}`;
      return "ok";
    }
    case "prefetch_sources": {
      const queries = details.searchedQueries as number | undefined;
      const browsed = details.browsedCount as number | undefined;
      return `${queries ?? 0} queries → ${browsed ?? 0} pages`;
    }
    case "scout": {
      const browsed = details.browsedCount as number | undefined;
      const total = details.totalResults as number | undefined;
      return `${browsed ?? 0} browsed (of ${total ?? 0})`;
    }
    case "take_note": {
      const merged = details.mergedCount as number | undefined;
      if (merged && merged > 0) return `merged into existing (+${merged})`;
      return "saved";
    }
    case "evaluate_progress":
      return "ok";
    case "screenshot":
      return "ok";
    case "plan_research":
      return "plan ready";
    case "submit_report": {
      const len = details.reportLength as number | undefined;
      return len ? `report ${formatBytes(len)}` : "report submitted";
    }
    default:
      return "ok";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Format tool arguments for display. */
function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "web_search":
      return `"${args.query}"`;
    case "browse_url": {
      const focus = args.focus ? `, focus="${args.focus}"` : "";
      return `"${args.url}"${focus}`;
    }
    case "take_note":
      return `"${args.title}"`;
    case "screenshot":
      return `"${args.url}"`;
    case "prefetch_sources": {
      const queries = args.queries as string[];
      return `${queries.length} queries`;
    }
    case "scout":
      return `"${args.query}"`;

    default:
      return "";
  }
}

/**
 * Rebuild in-memory state from replayed messages.
 *
 * Walks through assistant tool calls and successful tool result messages to reconstruct:
 * - notes: from successful take_note tool executions
 * - scrapedUrls: from successful browse_url/prefetch_sources/scout tool executions
 */
export function rebuildStateFromMessages(messages: AgentMessage[]): {
  notes: ResearchNote[];
  scrapedUrls: Set<string>;
} {
  const notes: ResearchNote[] = [];
  const scrapedUrls = new Set<string>();
  const noteCalls = new Map<string, ResearchNote>();
  const browseCalls = new Map<string, string>();

  for (const msg of messages) {
    if (!("role" in msg)) continue;

    // Record tool call arguments so successful tool results can be replayed safely.
    if (msg.role === "assistant") {
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
          noteCalls.set(content.id, {
            title: args.title,
            content: args.content,
            sourceUrls: args.sourceUrls,
            confidence: args.confidence,
            ...(args.keyExcerpts?.length ? { keyExcerpts: args.keyExcerpts } : {}),
          });
        } else if (content.name === "browse_url") {
          const args = content.arguments as { url: string };
          browseCalls.set(content.id, args.url);
        }
      }
    }

    if (msg.role !== "toolResult" || msg.isError) continue;

    if (msg.toolName === "take_note") {
      const note = noteCalls.get(msg.toolCallId);
      if (note) notes.push(note);
      continue;
    }

    if (msg.toolName === "browse_url") {
      const url = browseCalls.get(msg.toolCallId);
      if (url) scrapedUrls.add(url);
      continue;
    }

    // Extract scraped URLs from prefetch_sources and scout tool results.
    if (msg.toolName === "prefetch_sources" || msg.toolName === "scout") {
      const details = msg.details as {
        browsedUrls?: string[];
      } | undefined;
      if (details?.browsedUrls) {
        for (const url of details.browsedUrls) {
          scrapedUrls.add(url);
        }
      }
    }
  }

  return { notes, scrapedUrls };
}
