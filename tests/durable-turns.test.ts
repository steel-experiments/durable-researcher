// ABOUTME: Tests for the durable turns bridge between Absurd and Pi Agent.
// ABOUTME: Tests message log loading, state rebuilding from replayed messages.

import { describe, it, expect } from "vitest";
import { rebuildStateFromMessages } from "../src/durable-turns.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

describe("rebuildStateFromMessages", () => {
  it("returns empty state for empty messages", () => {
    const { notes, scrapedUrls } = rebuildStateFromMessages([]);
    expect(notes).toEqual([]);
    expect(scrapedUrls.size).toBe(0);
  });

  it("extracts notes from successful take_note tool results", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Research quantum computing",
        timestamp: Date.now(),
      } satisfies UserMessage,
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "take_note",
            arguments: {
              title: "Surface Codes",
              content: "Google uses surface codes for QEC",
              sourceUrls: ["https://research.google/qec"],
              confidence: "high",
            },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "take_note",
        content: [{ type: "text", text: "Note recorded" }],
        details: { noteIndex: 0, mergedCount: 0 },
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { notes } = rebuildStateFromMessages(messages);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Surface Codes");
    expect(notes[0].confidence).toBe("high");
    expect(notes[0].sourceUrls).toEqual(["https://research.google/qec"]);
  });

  it("does not mark browse_url tool calls as scraped before a tool result exists", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "browse_url",
            arguments: { url: "https://example.com/page1" },
          },
          {
            type: "toolCall",
            id: "tc-2",
            name: "browse_url",
            arguments: { url: "https://example.com/page2" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
    ];

    const { scrapedUrls } = rebuildStateFromMessages(messages);
    expect(scrapedUrls.size).toBe(0);
  });

  it("extracts scraped URLs from successful browse_url tool results", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "browse_url",
            arguments: { url: "https://example.com/page1" },
          },
          {
            type: "toolCall",
            id: "tc-2",
            name: "browse_url",
            arguments: { url: "https://example.com/page2" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "browse_url",
        content: [{ type: "text", text: "Page 1 content" }],
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
      {
        role: "toolResult",
        toolCallId: "tc-2",
        toolName: "browse_url",
        content: [{ type: "text", text: "Page 2 content" }],
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { scrapedUrls } = rebuildStateFromMessages(messages);
    expect(scrapedUrls.size).toBe(2);
    expect(scrapedUrls.has("https://example.com/page1")).toBe(true);
    expect(scrapedUrls.has("https://example.com/page2")).toBe(true);
  });

  it("extracts scraped URLs from prefetch_sources tool results", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "prefetch_sources",
            arguments: { queries: ["query A", "query B"] },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "prefetch_sources",
        content: [{ type: "text", text: "Prefetch results..." }],
        details: {
          browsedUrls: [
            "https://example.com/page1",
            "https://example.com/page2",
            "https://other.com/article",
          ],
        },
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { scrapedUrls } = rebuildStateFromMessages(messages);
    expect(scrapedUrls.size).toBe(3);
    expect(scrapedUrls.has("https://example.com/page1")).toBe(true);
    expect(scrapedUrls.has("https://example.com/page2")).toBe(true);
    expect(scrapedUrls.has("https://other.com/article")).toBe(true);
  });

  it("handles mixed messages with notes and browses", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Research topic",
        timestamp: Date.now(),
      } satisfies UserMessage,
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "browse_url",
            arguments: { url: "https://source.com/article" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "browse_url",
        content: [{ type: "text", text: "Page content summary" }],
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-2",
            name: "take_note",
            arguments: {
              title: "Key Finding",
              content: "Important discovery",
              sourceUrls: ["https://source.com/article"],
              confidence: "high",
            },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          inputTokens: 200,
          outputTokens: 75,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
      {
        role: "toolResult",
        toolCallId: "tc-2",
        toolName: "take_note",
        content: [{ type: "text", text: "Note recorded" }],
        details: { noteIndex: 0, mergedCount: 0 },
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { notes, scrapedUrls } = rebuildStateFromMessages(messages);
    expect(notes).toHaveLength(1);
    expect(scrapedUrls.size).toBe(1);
    expect(notes[0].title).toBe("Key Finding");
    expect(scrapedUrls.has("https://source.com/article")).toBe(true);
  });
});
