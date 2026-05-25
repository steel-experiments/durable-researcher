// ABOUTME: Live end-to-end exercise of the production createSearchTool with source=edgar.
// ABOUTME: Hits real SEC, exercises tool params + dedup + the new monty-backed adapter.

import type Steel from "steel-sdk";
import { createSearchTool } from "../src/tools/search.js";
import { hasExtractionSignals } from "../src/classify.js";

// Steel is only invoked when source !== "edgar", so a stub is fine here.
const steelStub = {} as Steel;

async function exerciseSearchTool() {
  console.log("\n========== TEST 1: tool .execute({ source: 'edgar' }) live ==========\n");
  const scrapedUrls = new Set<string>();
  const tool = createSearchTool(steelStub, scrapedUrls, "Tesla annual filings");

  const t0 = performance.now();
  const result = await tool.execute("test-call-1", {
    query: "Tesla annual report",
    source: "edgar",
  });
  const ms = Math.round(performance.now() - t0);

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  console.log(text.split("\n").slice(0, 14).join("\n"));
  console.log("…");
  console.log(`\nelapsed: ${ms}ms`);
  console.log("details:", result.details);

  // Pull URLs out of the formatted text for dedup test below.
  const urlMatches = [...text.matchAll(/URL: (https:\/\/\S+)/g)].map((m) => m[1]);
  console.log(`extracted ${urlMatches.length} URLs from formatted output`);
  return { urls: urlMatches, scrapedUrls, tool };
}

async function exerciseDedup(state: {
  urls: string[];
  scrapedUrls: Set<string>;
  tool: ReturnType<typeof createSearchTool>;
}) {
  console.log("\n========== TEST 2: dedup with pre-populated scrapedUrls ==========\n");
  // Seed the dedup set with everything from the first call.
  for (const u of state.urls) state.scrapedUrls.add(u);
  console.log(`seeded scrapedUrls with ${state.scrapedUrls.size} URLs`);

  const result = await state.tool.execute("test-call-2", {
    query: "Tesla annual report",
    source: "edgar",
  });
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  console.log(text);
  console.log("details:", result.details);
}

function exerciseClassifier() {
  console.log("\n========== TEST 3: classifier signal detection ==========\n");
  const cases: Array<{ topic: string; expect: boolean }> = [
    { topic: "Extract revenue from Apple's 10-K for fiscal 2024", expect: true },
    { topic: "Pull every R&D expense line from Tesla 10-K Q1 2024", expect: true },
    { topic: "Compare cloud margins of AWS vs Azure", expect: false },
    { topic: "Why did Pat Gelsinger resign?", expect: false },
    { topic: "List every restructuring charge from Intel filings FY 2023", expect: true },
  ];
  for (const { topic, expect } of cases) {
    const got = hasExtractionSignals(topic);
    const pass = got === expect ? "OK " : "MISS";
    console.log(`  [${pass}] expected=${expect} got=${got}  "${topic}"`);
  }
}

async function main() {
  const state = await exerciseSearchTool();
  await exerciseDedup(state);
  exerciseClassifier();
}

main().catch((e) => {
  console.error("live test failed:", e);
  process.exit(1);
});
