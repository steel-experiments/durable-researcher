// ABOUTME: JSONL append-only log of write_adapter runs. Feeds future promotion-to-blessed review.
// ABOUTME: One file per logical source, e.g. .adapters/history/arxiv.jsonl.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Resolved lazily — tests cd into tempdirs after import. */
function historyDir(): string {
  return join(process.cwd(), ".adapters", "history");
}

/** Max chars stored for output preview — full output can be large, history is for review not replay. */
const MAX_OUTPUT_PREVIEW = 4000;

export type HistoryRecord = {
  ts: string;
  source: string;
  purpose: string;
  code: string;
  inputs: Record<string, unknown>;
  durationMs: number;
  /** Truncated preview of the output (JSON-stringified). */
  outputPreview?: string;
  /** Set when the run failed. */
  error?: { type: string; message: string };
};

/** Sanitize a logical source name for use as a filename. */
function safeSource(source: string): string {
  return source.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "unknown";
}

/** Append one run record to .adapters/history/<source>.jsonl. */
export function appendHistory(record: HistoryRecord): void {
  const file = join(historyDir(), `${safeSource(record.source)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  appendFileSync(file, line, "utf8");
}

/** Produce a length-capped JSON preview of an arbitrary output value. */
export function previewOutput(output: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(output);
  } catch {
    s = String(output);
  }
  if (s.length <= MAX_OUTPUT_PREVIEW) return s;
  return s.slice(0, MAX_OUTPUT_PREVIEW) + `…[+${s.length - MAX_OUTPUT_PREVIEW} chars]`;
}
