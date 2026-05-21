// ABOUTME: Tests for the user steering queue used to inject mid-flight messages into the agent loop.
// ABOUTME: Verifies push/drain FIFO semantics, snapshot count, and empty-state behavior.

import { describe, it, expect } from "vitest";
import { createSteeringQueue } from "../src/steering-queue.js";

describe("createSteeringQueue", () => {
  it("returns an empty array when nothing has been queued", () => {
    const q = createSteeringQueue();
    expect(q.drain()).toEqual([]);
    expect(q.size()).toBe(0);
  });

  it("drains pushed messages in FIFO order", () => {
    const q = createSteeringQueue();
    q.push("first message");
    q.push("second message");
    q.push("third message");

    expect(q.size()).toBe(3);
    expect(q.drain()).toEqual(["first message", "second message", "third message"]);
  });

  it("drains clear the queue", () => {
    const q = createSteeringQueue();
    q.push("one");
    q.drain();
    expect(q.size()).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it("trims whitespace and rejects empty messages", () => {
    const q = createSteeringQueue();
    q.push("  spaced  ");
    q.push("");
    q.push("   ");
    q.push("real");

    expect(q.drain()).toEqual(["spaced", "real"]);
  });

  it("size reflects queue length without consuming items", () => {
    const q = createSteeringQueue();
    q.push("a");
    q.push("b");
    expect(q.size()).toBe(2);
    expect(q.size()).toBe(2);
    expect(q.drain()).toEqual(["a", "b"]);
  });
});
