// ABOUTME: Shared utilities for working with Pi Agent's AgentMessage type.
// ABOUTME: Lives outside agent.ts so non-task code (follow-up, eval, TUI) can import without pulling in Absurd.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

/**
 * Convert AgentMessages to LLM-compatible Messages.
 * Standard messages pass through; anything without a recognized role is filtered.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      "role" in m &&
      (m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
  );
}
