// ABOUTME: Tests for resume eligibility of existing research tasks.
// ABOUTME: Locks the rule that terminally-failed tasks are not resumable corpses.

import { describe, expect, it } from "vitest";
import { isResumable, type ExistingTask } from "../src/task-finder.js";

function task(overrides: Partial<ExistingTask>): ExistingTask {
  return {
    taskId: "t1",
    queueName: "default",
    topic: "example",
    status: "running",
    createdAt: new Date(0),
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("isResumable", () => {
  it("resumes in-progress tasks", () => {
    expect(isResumable(task({ status: "running" }))).toBe(true);
    expect(isResumable(task({ status: "pending" }))).toBe(true);
  });

  it("does not resume completed or cancelled tasks", () => {
    expect(isResumable(task({ status: "completed" }))).toBe(false);
    expect(isResumable(task({ status: "cancelled" }))).toBe(false);
  });

  it("does not resume a failed task that has exhausted its attempts", () => {
    expect(
      isResumable(task({ status: "failed", attempt: 3, maxAttempts: 3 })),
    ).toBe(false);
  });

  it("still resumes a failed task with attempts remaining", () => {
    expect(
      isResumable(task({ status: "failed", attempt: 1, maxAttempts: 3 })),
    ).toBe(true);
  });
});
