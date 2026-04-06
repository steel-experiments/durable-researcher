// ABOUTME: Bridge between Absurd step checkpoints and Pi Agent message log.
// ABOUTME: Implements the durable turns pattern: load, persist, and rebuild state from messages.

import type { TaskContext, StepHandle } from "absurd-sdk";
import type { AgentMessage, AgentEvent } from "@mariozechner/pi-agent-core";
import type { MessageLogEntry, ResearchNote } from "./types.js";

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

/** Tool display names and icons for progress logging. */
const TOOL_ICONS: Record<string, string> = {
  plan_research: "[PLAN]",
  web_search: "[SEARCH]",
  browse_url: "[BROWSE]",
  screenshot: "[SCREENSHOT]",
  take_note: "[NOTE]",
  evaluate_progress: "[EVALUATE]",
};

/**
 * Create an event sink that logs live progress to the console AND persists messages.
 * Wraps the checkpoint persister with human-readable output.
 */
export function createLoggingPersister(
  ctx: TaskContext,
  initialHandle: StepHandle<MessageLogEntry>,
): (event: AgentEvent) => Promise<void> {
  const persister = createMessagePersister(ctx, initialHandle);

  return async (event: AgentEvent) => {
    switch (event.type) {
      case "turn_start":
        console.log("\n--- New turn ---");
        break;

      case "tool_execution_start": {
        const icon = TOOL_ICONS[event.toolName] ?? "[TOOL]";
        const argSummary = formatToolArgs(event.toolName, event.args);
        console.log(`  ${icon} ${event.toolName}(${argSummary})`);
        break;
      }

      case "tool_execution_end": {
        const icon = TOOL_ICONS[event.toolName] ?? "[TOOL]";
        if (event.isError) {
          console.log(`  ${icon} FAILED`);
        }
        break;
      }

      case "message_end": {
        const msg = event.message;
        if ("role" in msg && msg.role === "assistant") {
          // Print any text content (thinking/final response)
          for (const c of msg.content) {
            if (c.type === "text" && c.text.length > 0) {
              // For long final reports, just show a preview
              if (c.text.length > 300) {
                console.log(`\n  [AGENT] ${c.text.slice(0, 200)}...`);
              } else {
                console.log(`\n  [AGENT] ${c.text}`);
              }
            }
          }

          // Show tool call summary
          const toolCalls = msg.content.filter(
            (c: { type: string }) => c.type === "toolCall",
          );
          if (toolCalls.length > 0) {
            console.log(
              `  Calling ${toolCalls.length} tool(s)...`,
            );
          }
        }
        break;
      }
    }

    // Always delegate to the checkpoint persister
    await persister(event);
  };
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
    default:
      return "";
  }
}

/**
 * Rebuild in-memory state from replayed messages.
 *
 * Walks through tool result messages to reconstruct:
 * - notes: from take_note tool results
 * - scrapedUrls: from browse_url tool results
 */
export function rebuildStateFromMessages(messages: AgentMessage[]): {
  notes: ResearchNote[];
  scrapedUrls: Set<string>;
} {
  const notes: ResearchNote[] = [];
  const scrapedUrls = new Set<string>();

  for (const msg of messages) {
    if (!("role" in msg)) continue;

    // Extract URLs from browse_url tool results
    if (msg.role === "toolResult" && msg.toolName === "browse_url") {
      const details = msg.details as { url?: string } | undefined;
      if (details?.url) {
        scrapedUrls.add(details.url);
      }
    }

    // Extract notes from take_note tool results
    if (msg.role === "toolResult" && msg.toolName === "take_note") {
      // The note details are stored in the tool result's details field
      // but the actual note data comes from the assistant's tool call args.
      // We need to look at the preceding assistant message to find the args.
      // However, for simplicity, we reconstruct from the text content.
      // The note tool returns a confirmation — the actual data was in the tool call.
    }

    // Extract notes from assistant messages (tool calls with take_note)
    if (msg.role === "assistant") {
      for (const content of msg.content) {
        if (content.type === "toolCall" && content.name === "take_note") {
          const args = content.arguments as {
            title: string;
            content: string;
            sourceUrls: string[];
            confidence: "high" | "medium" | "low";
          };
          notes.push({
            title: args.title,
            content: args.content,
            sourceUrls: args.sourceUrls,
            confidence: args.confidence,
          });
        }
      }
    }

    // Extract scraped URLs from assistant messages (tool calls with browse_url)
    if (msg.role === "assistant") {
      for (const content of msg.content) {
        if (content.type === "toolCall" && content.name === "browse_url") {
          const args = content.arguments as { url: string };
          scrapedUrls.add(args.url);
        }
      }
    }
  }

  return { notes, scrapedUrls };
}
