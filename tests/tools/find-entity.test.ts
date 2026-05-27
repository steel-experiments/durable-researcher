// ABOUTME: Tests for find_entity's kind-tailored query builder.
// ABOUTME: The search/browse path is exercised via scout's tests; here we lock the query routing.

import { describe, it, expect } from "vitest";
import { buildEntityQueries } from "../../src/tools/find-entity.js";

describe("buildEntityQueries", () => {
  it("routes papers to arxiv first", () => {
    const q = buildEntityQueries("τ-bench", "paper");
    expect(q[0]).toContain("arxiv");
    expect(q[0]).toContain("τ-bench");
  });

  it("routes systems to official docs / github", () => {
    const q = buildEntityQueries("AGDebugger", "system");
    expect(q.join(" ")).toMatch(/documentation|github/);
  });

  it("routes benchmarks to the benchmark paper", () => {
    const q = buildEntityQueries("WebArena", "benchmark");
    expect(q[0].toLowerCase()).toContain("benchmark");
  });

  it("routes people to publications / scholar", () => {
    const q = buildEntityQueries("Endsley", "person");
    expect(q.join(" ").toLowerCase()).toMatch(/publications|scholar/);
  });

  it("falls back to bare name for unknown kind", () => {
    const q = buildEntityQueries("Some Thing");
    expect(q[0]).toBe("Some Thing");
    expect(q.length).toBeGreaterThanOrEqual(1);
  });

  it("always includes the entity name in every query", () => {
    for (const kind of ["paper", "system", "benchmark", "person", "org", "metric"] as const) {
      const q = buildEntityQueries("NASA-TLX", kind);
      for (const query of q) expect(query).toContain("NASA-TLX");
    }
  });
});
