// ABOUTME: Tests for the durable turns bridge between Absurd and Pi Agent.
// ABOUTME: Tests message log loading, state rebuilding from replayed messages.

import { describe, it, expect } from "vitest";
import {
  rebuildStateFromMessages,
  summarizeToolResult,
} from "../src/durable-turns.js";
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

  it("extracts derived notes from successful record_claims tool results", () => {
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
            name: "record_claims",
            arguments: {
              claims: [
                {
                  text: "Google uses surface codes for QEC.",
                  sourceUrl: "https://research.google/qec",
                  excerpt: "Google uses surface codes for QEC.",
                  tier: "primary",
                },
              ],
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
        toolName: "record_claims",
        content: [{ type: "text", text: "Claim recorded" }],
        details: { recordedCount: 1, claimCount: 1 },
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { notes } = rebuildStateFromMessages(messages);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("Google uses surface codes");
    expect(notes[0].confidence).toBe("medium");
    expect(notes[0].sourceUrls).toEqual(["https://research.google/qec"]);
  });

  it("preserves excerpts when rebuilding from record_claims tool calls", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "record_claims",
            arguments: {
              claims: [
                {
                  text: "Surface codes are the leading approach.",
                  sourceUrl: "https://research.google/qec",
                  excerpt: "Surface codes are the leading approach",
                  tier: "primary",
                },
                {
                  text: "The error rate was 0.143%.",
                  sourceUrl: "https://research.google/qec",
                  excerpt: "Error rate 0.143%",
                  tier: "primary",
                },
              ],
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
        toolName: "record_claims",
        content: [{ type: "text", text: "Claim recorded" }],
        details: { recordedCount: 2, claimCount: 2 },
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { notes } = rebuildStateFromMessages(messages);
    expect(notes).toHaveLength(2);
    expect(notes.flatMap((note) => note.keyExcerpts ?? [])).toEqual([
      "Surface codes are the leading approach",
      "Error rate 0.143%",
    ]);
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

  it("does not count thin browse_url results as scraped sources", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "browse_url",
            arguments: { url: "https://example.com/login" },
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
        content: [{ type: "text", text: "Login | Sign up" }],
        details: { url: "https://example.com/login", meaningful: false },
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { scrapedUrls } = rebuildStateFromMessages(messages);
    expect(scrapedUrls.size).toBe(0);
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

  it("uses meaningful prefetch URLs when present", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "prefetch_sources",
        content: [{ type: "text", text: "Prefetch results..." }],
        details: {
          browsedUrls: ["https://example.com/login", "https://example.com/report"],
          meaningfulBrowsedUrls: ["https://example.com/report"],
        },
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { scrapedUrls } = rebuildStateFromMessages(messages);
    expect([...scrapedUrls]).toEqual(["https://example.com/report"]);
  });

  it("handles mixed messages with browses and recorded claims", () => {
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
            name: "record_claims",
            arguments: {
              claims: [
                {
                  text: "The source contains an important discovery.",
                  sourceUrl: "https://source.com/article",
                  excerpt: "Important discovery",
                  tier: "primary",
                },
              ],
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
        toolName: "record_claims",
        content: [{ type: "text", text: "Claim recorded" }],
        details: { recordedCount: 1, claimCount: 1 },
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
    ];

    const { notes, scrapedUrls } = rebuildStateFromMessages(messages);
    expect(notes).toHaveLength(1);
    expect(scrapedUrls.size).toBe(1);
    expect(notes[0].title).toContain("important discovery");
    expect(scrapedUrls.has("https://source.com/article")).toBe(true);
  });
});

describe("summarizeToolResult", () => {
  it("returns `error` plus first text line on tool error", () => {
    const result = { content: [{ type: "text", text: "Connection refused\nstack..." }] };
    expect(summarizeToolResult("browse_url", result, true)).toBe("error: Connection refused");
  });

  it("returns bare `error` when error has no text content", () => {
    expect(summarizeToolResult("browse_url", undefined, true)).toBe("error");
  });

  it("returns `ok` when there are no details", () => {
    expect(summarizeToolResult("browse_url", { content: [] }, false)).toBe("ok");
  });

  it("summarizes web_search with fresh/total counts", () => {
    const result = { details: { totalResults: 12, relevantResults: 8, freshResults: 5 } };
    expect(summarizeToolResult("web_search", result, false)).toBe("5 new (of 12)");
  });

  it("summarizes web_search when all results were already visited", () => {
    const result = { details: { totalResults: 8, relevantResults: 4, freshResults: 0 } };
    expect(summarizeToolResult("web_search", result, false)).toBe("0 new (of 8)");
  });

  it("summarizes browse_url with a formatted byte size", () => {
    const result = { details: { url: "u", title: "t", rawLength: 4200, meaningful: true } };
    expect(summarizeToolResult("browse_url", result, false)).toBe("4.1KB");
  });

  it("summarizes browse_url thin-content case", () => {
    const result = { details: { url: "u", title: "t", rawLength: 120, meaningful: false } };
    expect(summarizeToolResult("browse_url", result, false)).toBe("thin content (120b)");
  });

  it("summarizes prefetch_sources by queries and browsed pages", () => {
    const result = { details: { searchedQueries: 4, browsedCount: 7 } };
    expect(summarizeToolResult("prefetch_sources", result, false)).toBe("4 queries → 7 pages");
  });

  it("summarizes record_claims by evidence items and claims", () => {
    const result = { details: { recordedCount: 3, claimCount: 2 } };
    expect(summarizeToolResult("record_claims", result, false)).toBe("3 evidence item(s), 2 claims");
  });
});
