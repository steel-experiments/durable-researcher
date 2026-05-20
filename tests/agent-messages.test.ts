// ABOUTME: Tests for the shared convertToLlm utility.
// ABOUTME: Covers filtering of non-LLM message types and pass-through of standard roles.

import { describe, it, expect } from "vitest";
import { convertToLlm } from "../src/agent-messages.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

describe("convertToLlm", () => {
  it("returns an empty array for empty input", () => {
    expect(convertToLlm([])).toEqual([]);
  });

  it("passes through user, assistant, and toolResult messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1 } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "search",
        content: [{ type: "text", text: "results" }],
        isError: false,
        timestamp: 3,
      } as AgentMessage,
    ];
    const out = convertToLlm(messages);
    expect(out).toHaveLength(3);
  });

  it("filters messages without a role property", () => {
    const messages = [
      { weird: true } as unknown as AgentMessage,
      { role: "user", content: "hello", timestamp: 1 } as AgentMessage,
    ];
    expect(convertToLlm(messages)).toHaveLength(1);
  });

  it("filters messages with an unknown role", () => {
    const messages = [
      { role: "system", content: "..." } as unknown as AgentMessage,
      { role: "user", content: "ok", timestamp: 1 } as AgentMessage,
    ];
    expect(convertToLlm(messages)).toHaveLength(1);
  });
});
