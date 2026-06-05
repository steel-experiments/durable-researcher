// ABOUTME: Tests that message projection (resume replay) reconstructs ledger state faithfully.
// ABOUTME: Focuses on record_claims replay and derived note events.

import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createMessageProjector, projectMessage, projectMessages } from "../src/message-projector.js";

describe("projectMessages ledger reconstruction", () => {
  it("reconstructs the claim ledger from plan_research and record_claims replay", () => {
    const { ledger, notes } = projectMessages([
      {
        role: "toolResult",
        toolCallId: "plan-1",
        toolName: "plan_research",
        content: [{ type: "text", text: "plan" }],
        details: {
          requiredClaims: [
            { id: "rq1", question: "Find the answer", status: "open", claimIds: [] },
          ],
        },
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "claims-1",
          name: "record_claims",
          arguments: {
            claims: [
              {
                text: "The answer is X.",
                sourceUrl: "https://example.com/a",
                excerpt: "The answer is X.",
                tier: "primary",
                requiredClaimIds: ["rq1"],
              },
            ],
          },
        }],
        timestamp: Date.now(),
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "claims-1",
        toolName: "record_claims",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
    ]);

    expect(ledger.claims).toHaveLength(1);
    expect(ledger.requiredClaims[0].status).toBe("answered");
    expect(notes[0].title).toContain("The answer is X");
  });

  it("returns derived notes added by record_claims for live event emission", () => {
    const projector = createMessageProjector();
    projectMessage(projector, {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "claims-1",
        name: "record_claims",
        arguments: {
          claims: [
            {
              text: "Claim one.",
              sourceUrl: "https://example.com/one",
              excerpt: "Claim one.",
              tier: "primary",
            },
            {
              text: "Claim two.",
              sourceUrl: "https://example.com/two",
              excerpt: "Claim two.",
              tier: "primary",
            },
          ],
        },
      }],
      timestamp: Date.now(),
    } as unknown as AgentMessage);

    const delta = projectMessage(projector, {
      role: "toolResult",
      toolCallId: "claims-1",
      toolName: "record_claims",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage);

    expect(delta.notesAdded).toHaveLength(2);
    expect(delta.notesAdded?.[0].note.title).toContain("Claim one");
    expect(delta.notesAdded?.[1].index).toBe(1);
  });
});
