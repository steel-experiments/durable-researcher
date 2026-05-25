// ABOUTME: Smoke test — invokes the production use_adapter tool against the blessed src/adapters/arxiv.py.
// ABOUTME: Proves the no-code-gen path works end-to-end against the real arXiv API.

import { createUseAdapterTool } from "../src/tools/use-adapter.js";

const tool = createUseAdapterTool();
console.log("Tool description (first 400 chars):");
console.log(tool.description.slice(0, 400));
console.log("\n---");

const t0 = performance.now();
const result = await tool.execute("smoke-1", {
  source: "arxiv",
  inputs: { query: "durable execution workflow", max_results: 5 },
});
const ms = Math.round(performance.now() - t0);

const text = result.content
  .filter((c): c is { type: "text"; text: string } => c.type === "text")
  .map((c) => c.text)
  .join("\n");
console.log(`tool result (${ms}ms):\n`);
console.log(text.slice(0, 1200));

const details = result.details as { source: string; durationMs: number; output: unknown };
const papers = (details.output ?? []) as Array<{
  title: string;
  url: string;
  authors: string[];
  published: string;
}>;
console.log(`\n--- ${papers.length} papers via use_adapter('arxiv') ---\n`);
for (const [i, p] of papers.slice(0, 5).entries()) {
  console.log(`${i + 1}. ${p.title}`);
  console.log(`   ${p.url}  (${p.published.slice(0, 10)})`);
  console.log(`   ${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? ", …" : ""}\n`);
}
