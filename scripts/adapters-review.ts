// ABOUTME: CLI to review agent-authored adapter history and promote successful variants to blessed.
// ABOUTME: Reads .adapters/history/*.jsonl, groups by code hash, prints stats and offers promotion.

import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type HistoryRecord = {
  ts: string;
  source: string;
  purpose: string;
  code: string;
  inputs: Record<string, unknown>;
  durationMs: number;
  outputPreview?: string;
  error?: { type: string; message: string };
};

type VariantStats = {
  hash8: string;
  fullHash: string;
  runs: HistoryRecord[];
  successes: number;
  failures: number;
  firstSeen: string;
  lastSeen: string;
  totalDurationMs: number;
  sampleSuccess?: HistoryRecord;
  sampleError?: HistoryRecord;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const HISTORY_DIR = join(REPO_ROOT, ".adapters", "history");
const ADAPTERS_DIR = join(REPO_ROOT, "src", "adapters");

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function loadHistory(source?: string): Map<string, HistoryRecord[]> {
  const bySource = new Map<string, HistoryRecord[]>();
  if (!existsSync(HISTORY_DIR)) return bySource;

  const files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const name = f.replace(/\.jsonl$/, "");
    if (source && name !== source) continue;
    const text = readFileSync(join(HISTORY_DIR, f), "utf8");
    const records: HistoryRecord[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t) as HistoryRecord);
      } catch {
        // skip malformed line — history is append-only, partial writes possible
      }
    }
    bySource.set(name, records);
  }
  return bySource;
}

function variantStats(records: HistoryRecord[]): VariantStats[] {
  const byHash = new Map<string, HistoryRecord[]>();
  for (const r of records) {
    const fullHash = hashCode(r.code);
    if (!byHash.has(fullHash)) byHash.set(fullHash, []);
    byHash.get(fullHash)!.push(r);
  }

  const variants: VariantStats[] = [];
  for (const [fullHash, runs] of byHash) {
    const successes = runs.filter((r) => !r.error).length;
    const sampleSuccess = runs.find((r) => !r.error);
    const sampleError = runs.find((r) => r.error);
    const tss = runs.map((r) => r.ts).sort();
    variants.push({
      hash8: fullHash.slice(0, 8),
      fullHash,
      runs,
      successes,
      failures: runs.length - successes,
      firstSeen: tss[0],
      lastSeen: tss[tss.length - 1],
      totalDurationMs: runs.reduce((s, r) => s + r.durationMs, 0),
      ...(sampleSuccess ? { sampleSuccess } : {}),
      ...(sampleError ? { sampleError } : {}),
    });
  }
  // Best candidates first: more runs × higher success rate.
  variants.sort((a, b) => {
    const score = (v: VariantStats) =>
      v.runs.length * (v.successes / Math.max(1, v.runs.length));
    return score(b) - score(a);
  });
  return variants;
}

function previewCode(code: string, lines = 20): string {
  return code
    .split("\n")
    .slice(0, lines)
    .map((l) => "    " + l)
    .join("\n");
}

function previewOutput(record: HistoryRecord, len = 280): string {
  if (record.error) {
    return `error: ${record.error.type} — ${record.error.message}`;
  }
  return (record.outputPreview ?? "").slice(0, len).replace(/\n/g, " ");
}

function printSource(source: string, variants: VariantStats[]): void {
  const totalRuns = variants.reduce((s, v) => s + v.runs.length, 0);
  const totalOk = variants.reduce((s, v) => s + v.successes, 0);
  const avgMs = Math.round(
    variants.reduce((s, v) => s + v.totalDurationMs, 0) / Math.max(1, totalRuns),
  );

  console.log("");
  console.log("=".repeat(78));
  console.log(
    `${source}  —  ${totalRuns} runs, ${totalOk} ok (${Math.round(
      (totalOk * 100) / Math.max(1, totalRuns),
    )}%), ${variants.length} variant${variants.length === 1 ? "" : "s"}, avg ${avgMs}ms`,
  );
  console.log("=".repeat(78));

  const blessedPath = join(ADAPTERS_DIR, `${source}.py`);
  if (existsSync(blessedPath)) {
    console.log(`  ✓ blessed: src/adapters/${source}.py`);
  } else {
    console.log(`  ✗ not blessed (no src/adapters/${source}.py)`);
  }

  for (const v of variants) {
    const tag = v.successes === v.runs.length && v.successes > 0
      ? "✓"
      : v.successes === 0
        ? "✗"
        : "~";
    console.log("");
    console.log(
      `  ${tag} variant ${v.hash8}  —  ${v.successes}/${v.runs.length} ok, first ${v.firstSeen.slice(0, 19)}Z`,
    );
    console.log(`    purpose: ${v.runs[0].purpose}`);
    const record = v.sampleSuccess ?? v.sampleError ?? v.runs[0];
    console.log(`    sample:  ${previewOutput(record)}`);
    console.log("    code preview:");
    console.log(previewCode(v.runs[0].code));
  }
}

function promote(source: string, hash8: string): void {
  const bySource = loadHistory(source);
  const records = bySource.get(source);
  if (!records || records.length === 0) {
    console.error(`No history for source "${source}".`);
    process.exit(1);
  }
  const variants = variantStats(records);
  const v = variants.find((x) => x.hash8 === hash8);
  if (!v) {
    console.error(
      `No variant with hash ${hash8} in source "${source}". Run without --promote to list available variants.`,
    );
    process.exit(1);
  }
  if (v.successes === 0) {
    console.error(
      `Refusing to promote variant ${hash8}: 0 successful runs out of ${v.runs.length}.`,
    );
    process.exit(1);
  }
  const dest = join(ADAPTERS_DIR, `${source}.py`);
  if (existsSync(dest)) {
    console.error(
      `${dest} already exists. Move/delete the existing blessed adapter first if you want to replace it.`,
    );
    process.exit(1);
  }
  mkdirSync(ADAPTERS_DIR, { recursive: true });

  const header = [
    `# ABOUTME: ${source} adapter — blessed from agent-authored variant ${hash8}.`,
    `# ABOUTME: ${v.runs.length} runs in history, ${v.successes} successful. First authored ${v.firstSeen}.`,
    `# Original purpose: ${v.runs[0].purpose}`,
    "",
  ].join("\n");

  writeFileSync(dest, header + v.runs[0].code + "\n", "utf8");
  console.log(`Wrote ${dest} (${v.runs[0].code.split("\n").length} lines).`);
  console.log(
    "Next: expose it as a first-class tool by adding use_adapter('" +
      source +
      "', { ... }) — agent will reach for it before write_adapter.",
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const promoteIdx = args.indexOf("--promote");
  if (promoteIdx !== -1) {
    const spec = args[promoteIdx + 1];
    if (!spec || !spec.includes(":")) {
      console.error("Usage: --promote <source>:<hash8>");
      process.exit(1);
    }
    const [source, hash8] = spec.split(":");
    promote(source, hash8);
    return;
  }

  const filterIdx = args.indexOf("--source");
  const filter = filterIdx !== -1 ? args[filterIdx + 1] : undefined;

  const bySource = loadHistory(filter);
  if (bySource.size === 0) {
    console.log(
      filter
        ? `No history for source "${filter}".`
        : `No history yet. Agent-authored adapters will be logged to .adapters/history/<source>.jsonl when write_adapter is called.`,
    );
    return;
  }

  for (const [source, records] of bySource) {
    printSource(source, variantStats(records));
  }

  console.log("");
  console.log("To promote a variant: bun run scripts/adapters-review.ts --promote <source>:<hash8>");
}

main();
