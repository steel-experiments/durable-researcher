// ABOUTME: Tests for event bus emission from the persister and steering queue injection.
// ABOUTME: Verifies that AgentEvents fan out to the bus while preserving Absurd persistence.

import { describe, it, expect, vi } from "vitest";
import { createLoggingPersister, type UsageStats } from "../src/durable-turns.js";
import { createResearchEventBus, type ResearchEvent } from "../src/event-bus.js";
import { createSteeringQueue } from "../src/steering-queue.js";
import { drainUserSteering } from "../src/agent.js";
import type {
  AgentEvent,
  AgentMessage,
} from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";

/** Minimal TaskContext stub that supports completeStep, beginStep, heartbeat. */
function createCtxStub() {
  const completed: unknown[] = [];
  const ctx = {
    completeStep: vi.fn(async (_handle: unknown, state: unknown) => {
      completed.push(state);
    }),
    beginStep: vi.fn(async () => ({ done: false, id: "next" })),
    heartbeat: vi.fn(async (_seconds: number) => {}),
  };
  return { ctx, completed };
}

function makeOpts(): {
  maxSources: number;
  maxTurns: number;
  scrapedUrls: Set<string>;
  usage: UsageStats;
} {
  return {
    maxSources: 20,
    maxTurns: 45,
    scrapedUrls: new Set<string>(),
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, models: {} },
  };
}

describe("createLoggingPersister event emission", () => {
  it("emits turn-start with counters when given an event bus", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    const event: AgentEvent = { type: "turn_start" } as AgentEvent;
    await persister(event);

    expect(received).toContainEqual({
      type: "turn-start",
      turn: 1,
      sources: 0,
      maxSources: 20,
      maxTurns: 45,
    });
  });

  it("emits tool-start and tool-end for tool execution events", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    await persister({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "browse_url",
      args: { url: "https://example.com" },
    } as AgentEvent);
    await persister({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "browse_url",
      isError: false,
    } as AgentEvent);

    expect(received.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    const start = received[0] as Extract<ResearchEvent, { type: "tool-start" }>;
    expect(start.toolName).toBe("browse_url");
    expect(start.toolCallId).toBe("tc-1");
    expect(start.argSummary).toContain("example.com");
    const end = received[1] as Extract<ResearchEvent, { type: "tool-end" }>;
    expect(end.toolCallId).toBe("tc-1");
  });

  it("respects initialTurnCount so subsequent persisters keep counting up", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    // Simulate creating a rewrite persister after 2 research turns already happened.
    const opts = { ...makeOpts(), eventBus: bus, quiet: true, initialTurnCount: 2 };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    await persister({ type: "turn_start" } as AgentEvent);

    const turnEvent = received.find(
      (e): e is Extract<ResearchEvent, { type: "turn-start" }> => e.type === "turn-start",
    );
    expect(turnEvent?.turn).toBe(3);
  });

  it("propagates distinct toolCallIds so parallel calls of the same tool don't collide", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    // Parallel calls of the same tool must stay keyed by toolCallId, not tool name.
    for (let i = 1; i <= 3; i++) {
      await persister({
        type: "tool_execution_start",
        toolCallId: `tc-${i}`,
        toolName: "record_claims",
        args: { claims: [{ text: `Claim ${i}` }] },
      } as AgentEvent);
    }
    const starts = received.filter((e) => e.type === "tool-start") as Array<
      Extract<ResearchEvent, { type: "tool-start" }>
    >;
    expect(starts.map((s) => s.toolCallId)).toEqual(["tc-1", "tc-2", "tc-3"]);
    expect(starts.map((s) => s.argSummary)).toEqual([
      "1 claim(s)",
      "1 claim(s)",
      "1 claim(s)",
    ]);
  });

  it("emits note-added events when record_claims adds ledger claims", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "claims-1",
          name: "record_claims",
          arguments: {
            claims: [
              {
                text: "Ledger claim one.",
                sourceUrl: "https://example.com/one",
                excerpt: "Ledger claim one.",
                tier: "primary",
              },
              {
                text: "Ledger claim two.",
                sourceUrl: "https://example.com/two",
                excerpt: "Ledger claim two.",
                tier: "primary",
              },
            ],
          },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    await persister({ type: "message_end", message: assistantMsg } as AgentEvent);

    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "claims-1",
      toolName: "record_claims",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    };
    await persister({ type: "message_end", message: toolResult } as AgentEvent);

    const noteEvents = received.filter((e) => e.type === "note-added");
    expect(noteEvents).toHaveLength(2);
    const first = noteEvents[0] as Extract<ResearchEvent, { type: "note-added" }>;
    expect(first.note.title).toContain("Ledger claim one");
    expect(first.index).toBe(0);
  });

  it("emits browse-added when a successful browse_url toolResult arrives", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "browse_url",
          arguments: { url: "https://example.com/page" },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    await persister({ type: "message_end", message: assistantMsg } as AgentEvent);

    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "browse_url",
      content: [{ type: "text", text: "page body" }],
      isError: false,
      timestamp: Date.now(),
    };
    await persister({ type: "message_end", message: toolResult } as AgentEvent);

    const browse = received.filter((e) => e.type === "browse-added");
    expect(browse).toHaveLength(1);
    expect((browse[0] as Extract<ResearchEvent, { type: "browse-added" }>).url).toBe(
      "https://example.com/page",
    );
  });

  it("does not emit browse-added for thin browse_url results", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    const assistantMsg: AssistantMessage = {
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
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    await persister({ type: "message_end", message: assistantMsg } as AgentEvent);

    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "browse_url",
      content: [{ type: "text", text: "Login | Sign up" }],
      details: { meaningful: false },
      isError: false,
      timestamp: Date.now(),
    };
    await persister({ type: "message_end", message: toolResult } as AgentEvent);

    expect(received.filter((e) => e.type === "browse-added")).toHaveLength(0);
  });

  it("emits report-text on terminal assistant message (no tool calls, long text)", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    const longReport = "x".repeat(600);
    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: longReport }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    await persister({ type: "message_end", message: assistantMsg } as AgentEvent);

    const reports = received.filter((e) => e.type === "report-text");
    expect(reports).toHaveLength(1);
    expect((reports[0] as Extract<ResearchEvent, { type: "report-text" }>).text).toBe(longReport);
  });

  it("forwards text_delta from message_update as agent-text", async () => {
    const { ctx } = createCtxStub();
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    const partial: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    await persister({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial },
    } as AgentEvent);
    await persister({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world", partial },
    } as AgentEvent);
    // Non-text deltas (thinking/toolcall) should not produce agent-text events
    await persister({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning…", partial },
    } as AgentEvent);

    const texts = received.filter((e) => e.type === "agent-text");
    expect(texts).toHaveLength(2);
    expect((texts[0] as Extract<ResearchEvent, { type: "agent-text" }>).delta).toBe("hello");
    expect((texts[1] as Extract<ResearchEvent, { type: "agent-text" }>).delta).toBe(" world");
  });

  it("quiet flag suppresses console.log", async () => {
    const { ctx } = createCtxStub();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const opts = { ...makeOpts(), quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    await persister({ type: "turn_start" } as AgentEvent);
    await persister({
      type: "tool_execution_start",
      toolName: "browse_url",
      args: { url: "https://x.com" },
    } as AgentEvent);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("default (no quiet, no bus) preserves prior console.log behavior", async () => {
    const { ctx } = createCtxStub();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const opts = makeOpts();
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    await persister({ type: "turn_start" } as AgentEvent);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still persists messages to Absurd alongside emitting events", async () => {
    const { ctx, completed } = createCtxStub();
    const bus = createResearchEventBus();

    const opts = { ...makeOpts(), eventBus: bus, quiet: true };
    const persister = createLoggingPersister(ctx as any, { id: "h" } as any, opts);

    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "short" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    await persister({ type: "message_end", message: msg } as AgentEvent);
    expect(completed).toHaveLength(1);
  });
});

describe("drainUserSteering", () => {
  it("returns empty array when queue is undefined", () => {
    expect(drainUserSteering(undefined)).toEqual([]);
  });

  it("returns empty array when queue is empty", () => {
    const q = createSteeringQueue();
    expect(drainUserSteering(q)).toEqual([]);
  });

  it("wraps drained text in USER STEERING-tagged user messages", () => {
    const q = createSteeringQueue();
    q.push("focus on peer-reviewed sources only");
    q.push("skip vendor blogs");

    const messages = drainUserSteering(q);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("[USER STEERING]");
    expect(messages[0].content).toContain("focus on peer-reviewed sources only");
    expect(messages[1].content).toContain("skip vendor blogs");
  });

  it("clears the queue after draining", () => {
    const q = createSteeringQueue();
    q.push("a");
    drainUserSteering(q);
    expect(q.size()).toBe(0);
  });
});
