// ABOUTME: Tests for the typed in-process research event bus.
// ABOUTME: Verifies subscribe/emit semantics, ordering, multiple subscribers, and unsubscribe.

import { describe, it, expect, vi } from "vitest";
import { createResearchEventBus, type ResearchEvent } from "../src/event-bus.js";
import type { ResearchNote } from "../src/types.js";

describe("createResearchEventBus", () => {
  it("delivers a single event to a single subscriber", () => {
    const bus = createResearchEventBus();
    const handler = vi.fn();
    bus.subscribe(handler);

    const note: ResearchNote = {
      title: "Test",
      content: "Body",
      sourceUrls: ["https://example.com"],
      confidence: "high",
    };
    bus.emit({ type: "note-added", note, index: 0 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "note-added", note, index: 0 });
  });

  it("delivers events to multiple subscribers in subscription order", () => {
    const bus = createResearchEventBus();
    const calls: string[] = [];
    bus.subscribe(() => calls.push("a"));
    bus.subscribe(() => calls.push("b"));
    bus.subscribe(() => calls.push("c"));

    bus.emit({ type: "turn-start", turn: 1, sources: 0, maxSources: 20, maxTurns: 45 });

    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("unsubscribes via the returned disposer", () => {
    const bus = createResearchEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe(handler);

    bus.emit({ type: "turn-start", turn: 1, sources: 0, maxSources: 20, maxTurns: 45 });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    bus.emit({ type: "turn-start", turn: 2, sources: 1, maxSources: 20, maxTurns: 45 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates subscriber errors so other subscribers still receive events", () => {
    const bus = createResearchEventBus();
    const good = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(good);

    expect(() =>
      bus.emit({ type: "turn-start", turn: 1, sources: 0, maxSources: 20, maxTurns: 45 }),
    ).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("supports all declared event variants without compile error", () => {
    const bus = createResearchEventBus();
    const received: ResearchEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const note: ResearchNote = {
      title: "T",
      content: "B",
      sourceUrls: [],
      confidence: "medium",
    };

    bus.emit({ type: "turn-start", turn: 1, sources: 0, maxSources: 20, maxTurns: 45 });
    bus.emit({ type: "tool-start", toolCallId: "call_1", toolName: "browse_url", argSummary: '"https://x.com"' });
    bus.emit({ type: "tool-end", toolCallId: "call_1", toolName: "browse_url", isError: false, summary: "3.2KB" });
    bus.emit({ type: "browse-added", url: "https://x.com" });
    bus.emit({ type: "note-added", note, index: 0 });
    bus.emit({ type: "agent-text", delta: "hello " });
    bus.emit({ type: "report-text", text: "Final report body" });
    bus.emit({
      type: "usage-update",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, models: {} },
    });
    bus.emit({ type: "agent-status", text: "Loading checkpoint..." });
    bus.emit({ type: "snapshot", turn: 3, sources: 2, notes: [note] });
    bus.emit({ type: "phase", phase: "verifying" });
    bus.emit({
      type: "verification-result",
      passRate: 0.7,
      supported: 7,
      total: 10,
      threshold: 0.7,
      willRewrite: false,
      attempt: 1,
    });
    bus.emit({ type: "phase", phase: "rewriting" });
    bus.emit({ type: "phase", phase: "complete" });
    bus.emit({ type: "task-complete" });
    bus.emit({ type: "task-error", message: "oops" });

    expect(received.map((e) => e.type)).toEqual([
      "turn-start",
      "tool-start",
      "tool-end",
      "browse-added",
      "note-added",
      "agent-text",
      "report-text",
      "usage-update",
      "agent-status",
      "snapshot",
      "phase",
      "verification-result",
      "phase",
      "phase",
      "task-complete",
      "task-error",
    ]);
  });
});
