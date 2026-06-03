// ABOUTME: Tests for assembling the research tool set, including adapter quarantine.
// ABOUTME: Adapter tools must be withheld from agents that browse untrusted web content.

import { describe, it, expect } from "vitest";
import { createResearchTools, type ResearchToolOptions } from "../src/research-tools.js";
import { createUrlExcerptStore } from "../src/url-excerpts.js";

function baseOptions(overrides: Partial<ResearchToolOptions> = {}): ResearchToolOptions {
  return {
    client: {} as ResearchToolOptions["client"],
    scrapedUrls: new Set<string>(),
    notes: [],
    params: { topic: "test topic" },
    mode: "synthesis",
    maxSources: 20,
    gapPasses: 0,
    taskId: "task-1",
    urlExcerpts: createUrlExcerptStore(),
    ...overrides,
  };
}

const ADAPTER_TOOLS = ["write_adapter", "use_adapter"];

describe("createResearchTools adapter quarantine", () => {
  it("includes adapter tools by default", () => {
    const names = createResearchTools(baseOptions()).map((t) => t.name);
    for (const name of ADAPTER_TOOLS) expect(names).toContain(name);
  });

  it("includes adapter tools when allowAdapters is explicitly true", () => {
    const names = createResearchTools(baseOptions({ allowAdapters: true })).map((t) => t.name);
    for (const name of ADAPTER_TOOLS) expect(names).toContain(name);
  });

  it("withholds adapter tools when allowAdapters is false", () => {
    const names = createResearchTools(baseOptions({ allowAdapters: false })).map((t) => t.name);
    for (const name of ADAPTER_TOOLS) expect(names).not.toContain(name);
    // Core browsing/search tools must still be present.
    expect(names).toContain("browse_url");
    expect(names).toContain("web_search");
  });
});
