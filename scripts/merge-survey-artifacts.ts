// ABOUTME: CLI wrapper around src/survey-merge.ts for ad-hoc merging of saved subagent reports.
// ABOUTME: Reads agent-N-report.md files from a directory and writes the deterministic merge.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mergeSurveyReports } from "../src/survey-merge.js";

const dir = process.argv[2] ?? "/tmp/orch-artifacts";
const out = process.argv[3] ?? join(dir, "merged-deterministic.md");

const files = readdirSync(dir)
  .filter((f) => /^agent-\d+-report\.md$/.test(f))
  .sort();

if (files.length === 0) {
  console.error(`No agent-N-report.md files found in ${dir}`);
  process.exit(1);
}

const inputs = files.map((f, i) => ({
  label: `Subagent ${i + 1}`,
  report: readFileSync(join(dir, f), "utf-8"),
}));

const { markdown, stats } = mergeSurveyReports(inputs);
writeFileSync(out, markdown);

console.log(`Merged ${files.length} reports → ${out}`);
console.log(`  chars: ${markdown.length}`);
console.log(`  systems: ${stats.systems}, benchmarks: ${stats.benchmarks}, literature: ${stats.literature}`);
console.log(`  sources: ${stats.sources}`);
