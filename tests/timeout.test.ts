// ABOUTME: Tests for graceful timeout handling — steering messages and partial result building.
// ABOUTME: Verifies timeout detection fires at correct threshold and buildResult handles missing reports.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

// We test buildResult and the timeout steering logic as exported from agent.ts
// buildResult is not currently exported, so we'll test via the module boundary.
// For now, we import the pieces we can test directly.

describe("buildPartialReport", () => {
  // Import the function once it's created
  let buildPartialReport: (
    notes: { title: string; content: string; sourceUrls: string[] }[],
    topic: string,
  ) => string;

  beforeEach(async () => {
    const mod = await import("../src/agent.js");
    buildPartialReport = mod.buildPartialReport;
  });

  it("generates a report from notes when no assistant report exists", () => {
    const notes = [
      {
        title: "Surface Codes",
        content: "Google uses surface codes for quantum error correction.",
        sourceUrls: ["https://research.google/qec"],
      },
      {
        title: "Ion Traps",
        content: "IonQ uses trapped ion qubits for computation.",
        sourceUrls: ["https://ionq.com/tech"],
      },
    ];

    const report = buildPartialReport(notes, "quantum computing");
    expect(report).toContain("[Partial results");
    expect(report).toContain("2 notes");
    expect(report).toContain("Surface Codes");
    expect(report).toContain("Ion Traps");
    expect(report).toContain("https://research.google/qec");
    expect(report).toContain("https://ionq.com/tech");
  });

  it("returns empty string for no notes", () => {
    const report = buildPartialReport([], "test topic");
    expect(report).toBe("");
  });

  it("includes all source URLs from notes", () => {
    const notes = [
      {
        title: "Multi-source finding",
        content: "Cross-referenced fact from multiple sources.",
        sourceUrls: ["https://a.com", "https://b.com", "https://c.com"],
      },
    ];

    const report = buildPartialReport(notes, "test");
    expect(report).toContain("https://a.com");
    expect(report).toContain("https://b.com");
    expect(report).toContain("https://c.com");
  });
});

describe("createTimeoutSteeringCheck", () => {
  let createTimeoutSteeringCheck: (
    taskStartTime: number,
    maxDuration: number,
    timeoutBuffer: number,
  ) => () => { shouldStop: boolean; message: string | null };

  beforeEach(async () => {
    const mod = await import("../src/agent.js");
    createTimeoutSteeringCheck = mod.createTimeoutSteeringCheck;
  });

  it("does not fire before the threshold", () => {
    const startTime = Date.now();
    const check = createTimeoutSteeringCheck(startTime, 600_000, 60_000);

    // Well before deadline
    const result = check();
    expect(result.shouldStop).toBe(false);
    expect(result.message).toBeNull();
  });

  it("fires when elapsed time exceeds maxDuration - buffer", () => {
    // Start time 550 seconds ago (past the 540s threshold for 600s max, 60s buffer)
    const startTime = Date.now() - 550_000;
    const check = createTimeoutSteeringCheck(startTime, 600_000, 60_000);

    const result = check();
    expect(result.shouldStop).toBe(true);
    expect(result.message).toContain("timeout");
  });

  it("fires only once", () => {
    const startTime = Date.now() - 550_000;
    const check = createTimeoutSteeringCheck(startTime, 600_000, 60_000);

    const first = check();
    expect(first.shouldStop).toBe(true);
    expect(first.message).not.toBeNull();

    const second = check();
    expect(second.shouldStop).toBe(true);
    expect(second.message).toBeNull(); // Message only sent once
  });

  it("respects custom buffer values", () => {
    // 100s buffer: threshold = 600 - 100 = 500s
    const startTime = Date.now() - 510_000; // 510s elapsed, past 500s threshold
    const check = createTimeoutSteeringCheck(startTime, 600_000, 100_000);

    const result = check();
    expect(result.shouldStop).toBe(true);
  });
});

describe("buildResult with partial reports", () => {
  let buildResult: (
    notes: { title: string; content: string; sourceUrls: string[] }[],
    topic: string,
    messages: AgentMessage[],
  ) => { topic: string; report: string; notes: any[]; sources: any[]; messages: AgentMessage[] };

  beforeEach(async () => {
    const mod = await import("../src/agent.js");
    buildResult = mod.buildResult;
  });

  it("extracts report from final assistant message", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Research quantum computing",
        timestamp: Date.now(),
      } satisfies UserMessage,
      {
        role: "assistant",
        content: [
          { type: "text", text: "This is the final research report about quantum computing. It covers many topics and is quite long and detailed with over 500 characters of content to ensure it looks like a real report." },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "endTurn",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
    ];

    const result = buildResult([], "quantum computing", messages);
    expect(result.report).toContain("final research report");
  });

  it("falls back to partial report when no assistant message with report text", () => {
    const notes = [
      {
        title: "Key Finding",
        content: "Important fact about the topic.",
        sourceUrls: ["https://example.com"],
      },
    ];

    // Only a user message, no assistant report
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Research something",
        timestamp: Date.now(),
      } satisfies UserMessage,
    ];

    const result = buildResult(notes, "test topic", messages);
    expect(result.report).toContain("[Partial results");
    expect(result.report).toContain("Key Finding");
  });

  it("falls back to partial when last assistant message only has tool calls", () => {
    const notes = [
      {
        title: "Finding",
        content: "Some content here.",
        sourceUrls: ["https://example.com"],
      },
    ];

    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "web_search",
            arguments: { query: "test" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
    ];

    const result = buildResult(notes, "test topic", messages);
    expect(result.report).toContain("[Partial results");
  });
});
