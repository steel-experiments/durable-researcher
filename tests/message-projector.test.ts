// ABOUTME: Tests that message projection (resume replay) reconstructs note state faithfully.
// ABOUTME: Focuses on the source-tier confidence cap matching the live take_note tool.

import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { projectMessages } from "../src/message-projector.js";

/** Build the assistant tool-call + tool-result pair a successful take_note produces. */
function noteMessages(args: Record<string, unknown>): AgentMessage[] {
  const toolCallId = "tc-1";
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "take_note", arguments: args }],
      timestamp: Date.now(),
    } as unknown as AgentMessage,
    {
      role: "toolResult",
      toolCallId,
      toolName: "take_note",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage,
  ];
}

describe("projectMessages note reconstruction", () => {
  it("re-applies the source-tier confidence cap on resume", () => {
    const { notes } = projectMessages(
      noteMessages({
        title: "Forum claim",
        content: "Someone said 99%",
        sourceUrls: ["https://reddit.com/r/ml"],
        confidence: "high",
        sourceTier: "forum",
      }),
    );
    expect(notes).toHaveLength(1);
    // Resume must match the live tool: forum caps high → low.
    expect(notes[0].confidence).toBe("low");
    expect(notes[0].sourceTier).toBe("forum");
  });

  it("leaves untiered notes unchanged on resume (back-compat)", () => {
    const { notes } = projectMessages(
      noteMessages({
        title: "Legacy note",
        content: "No tier",
        sourceUrls: ["https://example.com"],
        confidence: "high",
      }),
    );
    expect(notes[0].confidence).toBe("high");
    expect(notes[0].sourceTier).toBeUndefined();
  });
});
