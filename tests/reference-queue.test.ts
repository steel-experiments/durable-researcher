// ABOUTME: Tests for the reference queue and citation-candidate extraction.
// ABOUTME: Pure logic only — dedup, capping, arXiv/URL extraction, paper-URL detection.

import { describe, it, expect } from "vitest";
import {
  createReferenceQueue,
  extractReferenceCandidates,
  isPaperLikeUrl,
  MAX_REFERENCE_QUEUE,
} from "../src/reference-queue.js";

describe("createReferenceQueue", () => {
  it("adds and drains in FIFO order", () => {
    const q = createReferenceQueue();
    q.add(["a", "b", "c"]);
    expect(q.size).toBe(3);
    expect(q.drain(2)).toEqual(["a", "b"]);
    expect(q.size).toBe(1);
    expect(q.drain(10)).toEqual(["c"]);
    expect(q.size).toBe(0);
  });

  it("deduplicates within the queue", () => {
    const q = createReferenceQueue();
    q.add(["a", "a", "b"]);
    q.add(["b", "c"]);
    expect(q.drain(10)).toEqual(["a", "b", "c"]);
  });

  it("skips refs already in the shared seen set", () => {
    const seen = new Set<string>(["https://visited.com"]);
    const q = createReferenceQueue(seen);
    q.add(["https://visited.com", "https://new.com"]);
    expect(q.drain(10)).toEqual(["https://new.com"]);
  });

  it("ignores blank entries", () => {
    const q = createReferenceQueue();
    q.add(["  ", "", "x"]);
    expect(q.drain(10)).toEqual(["x"]);
  });

  it("caps at MAX_REFERENCE_QUEUE", () => {
    const q = createReferenceQueue();
    q.add(Array.from({ length: MAX_REFERENCE_QUEUE + 20 }, (_, i) => `r${i}`));
    expect(q.size).toBe(MAX_REFERENCE_QUEUE);
  });
});

describe("isPaperLikeUrl", () => {
  it("recognizes primary-source hosts", () => {
    expect(isPaperLikeUrl("https://arxiv.org/abs/2406.12045")).toBe(true);
    expect(isPaperLikeUrl("https://doi.org/10.1145/xyz")).toBe(true);
    expect(isPaperLikeUrl("https://aclanthology.org/2024.acl-long.1")).toBe(true);
    expect(isPaperLikeUrl("https://openreview.net/forum?id=abc")).toBe(true);
    expect(isPaperLikeUrl("https://example.com/paper.pdf")).toBe(true);
  });

  it("rejects ordinary web pages", () => {
    expect(isPaperLikeUrl("https://www.anthropic.com/research/building-effective-agents")).toBe(false);
    expect(isPaperLikeUrl("https://langchain.com/articles/agent-observability")).toBe(false);
  });
});

describe("extractReferenceCandidates", () => {
  it("normalizes arXiv IDs to abs URLs", () => {
    const out = extractReferenceCandidates("See arXiv:2406.12045 and arXiv: 2603.19685v2 for details.");
    expect(out).toContain("https://arxiv.org/abs/2406.12045");
    expect(out).toContain("https://arxiv.org/abs/2603.19685");
  });

  it("extracts bare URLs and strips trailing punctuation", () => {
    const out = extractReferenceCandidates("Refs: https://example.com/a, and (https://example.com/b).");
    expect(out).toContain("https://example.com/a");
    expect(out).toContain("https://example.com/b");
  });

  it("dedupes and respects the max", () => {
    const content = "https://x.com/1 https://x.com/1 https://x.com/2 https://x.com/3";
    expect(extractReferenceCandidates(content, 2)).toEqual(["https://x.com/1", "https://x.com/2"]);
  });

  it("returns empty when there are no references", () => {
    expect(extractReferenceCandidates("Just some prose with no links or arxiv ids.")).toEqual([]);
  });
});
