// ABOUTME: Deterministic union of survey-mode subagent reports — no LLM generation.
// ABOUTME: Merges the three survey tables across reports and remaps citations to one global Sources list.

// Why deterministic: the multi-agent orchestrator's LLM synthesis step collapsed four
// good 21-25KB survey reports into a 258-char meta-acknowledgement. Subagents already
// emit structured markdown (Systems / Benchmarks / Literature pipe-tables + numbered
// Sources); merging that is parsing, not generation. This module unions the tables by
// entity name, rebuilds one global Sources list, and rewrites every [n] marker —
// preserving every subagent's work at zero token cost.

/** One subagent report to merge. */
export type SurveyReportInput = { label: string; report: string };

export type SurveyMergeStats = {
  systems: number;
  benchmarks: number;
  literature: number;
  sources: number;
};

export type SurveyMergeResult = {
  markdown: string;
  stats: SurveyMergeStats;
};

type Table = { header: string[]; rows: { key: string; cells: string[] }[] };
type ParsedReport = {
  label: string;
  title: string;
  sections: Map<string, string>;
  sources: Map<number, string>; // local citation number -> URL
};

const CITATION_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
// Subagents number Sources inconsistently: "17. Desc — url" or "[17] url". Match both.
const SOURCE_LINE_RE = /^\s*(?:\[(\d+)\]|(\d+)\.)\s+(.*)$/;
const URL_RE = /(https?:\/\/[^\s)]+)/;

/** The three survey tables, in report order. */
export const SURVEY_TABLE_SECTIONS = [
  "Systems / Tools Surveyed",
  "Benchmarks / Datasets",
  "Literature",
] as const;

/** The prose sections concatenated (not table-merged) across reports. */
const PROSE_SECTIONS = ["Cross-Cutting Findings", "Gaps & Open Problems"] as const;

function parseSections(md: string): { title: string; sections: Map<string, string> } {
  const lines = md.split("\n");
  let title = "";
  const sections = new Map<string, string>();
  let current = "";
  let buf: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }
    if (h2) {
      flush();
      current = h2[1].trim();
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return { title, sections };
}

function parseSources(body: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of body.split("\n")) {
    const m = line.match(SOURCE_LINE_RE);
    if (!m) continue;
    const n = Number.parseInt(m[1] ?? m[2], 10);
    const url = m[3].match(URL_RE)?.[1];
    if (Number.isFinite(n) && url) map.set(n, url.replace(/[).,]+$/, ""));
  }
  return map;
}

function parseTable(body: string): Table | null {
  const lines = body.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return null;
  const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
  const header = cells(lines[0]);
  const rows: Table["rows"] = [];
  for (let i = 2; i < lines.length; i++) {
    const c = cells(lines[i]);
    if (c.length === 0 || c.every((x) => x === "")) continue;
    rows.push({ key: normalizeKey(c[0]), cells: c });
  }
  return { header, rows };
}

/** Normalize an entity name for dedup: lowercase, drop markdown / parentheticals / versions. */
export function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\bv?\d+(\.\d+)*\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseReport(input: SurveyReportInput): ParsedReport {
  const { title, sections } = parseSections(input.report);
  return {
    label: input.label,
    title,
    sections,
    sources: parseSources(sections.get("Sources") ?? ""),
  };
}

function buildCitationRemapper(reports: ParsedReport[]) {
  const urlToGlobal = new Map<string, number>();
  const globalOrder: string[] = [];
  for (const r of reports) {
    for (const url of r.sources.values()) {
      if (!urlToGlobal.has(url)) {
        urlToGlobal.set(url, globalOrder.length + 1);
        globalOrder.push(url);
      }
    }
  }
  const rewrite = (text: string, report: ParsedReport): string =>
    text.replace(CITATION_RE, (_m, group: string) => {
      const globals = group
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .map((local) => {
          const url = report.sources.get(local);
          return url ? urlToGlobal.get(url) : undefined;
        })
        .filter((n): n is number => n !== undefined);
      return globals.length ? `[${[...new Set(globals)].sort((a, b) => a - b).join(", ")}]` : "";
    });
  return { globalOrder, rewrite };
}

/**
 * Find an existing key whose token set is a subset/superset of `key` (multi-word only),
 * so "a2a protocol" and "google a2a protocol" collapse. Single-token keys never fuzzy-match.
 */
function findSubsetKey(key: string, merged: Map<string, string[]>): string | null {
  const a = new Set(key.split(" ").filter(Boolean));
  if (a.size < 2) return null;
  for (const existing of merged.keys()) {
    const b = new Set(existing.split(" ").filter(Boolean));
    if (b.size < 2) continue;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    if ([...small].every((t) => big.has(t))) return existing;
  }
  return null;
}

function mergeTable(
  sectionName: string,
  reports: ParsedReport[],
  rewrite: (text: string, r: ParsedReport) => string,
): { markdown: string; rows: number } | null {
  const merged = new Map<string, string[]>();
  let header: string[] | null = null;
  for (const r of reports) {
    const body = r.sections.get(sectionName);
    if (!body) continue;
    const table = parseTable(body);
    if (!table) continue;
    if (!header || table.header.length > header.length) header = table.header;
    for (const row of table.rows) {
      if (!row.key) continue;
      const rewritten = row.cells.map((c) => rewrite(c, r));
      const matchKey = findSubsetKey(row.key, merged) ?? row.key;
      const existing = merged.get(matchKey);
      if (!existing) {
        merged.set(matchKey, rewritten);
      } else {
        for (let i = 0; i < rewritten.length; i++) {
          if ((rewritten[i]?.length ?? 0) > (existing[i]?.length ?? 0)) existing[i] = rewritten[i];
        }
      }
    }
  }
  if (!header || merged.size === 0) return null;
  const rows = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]));
  const markdown = [
    `## ${sectionName}`,
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    "",
    `*${rows.length} distinct entries merged from ${reports.length} subagent reports.*`,
  ].join("\n");
  return { markdown, rows: rows.length };
}

function concatProse(
  sectionName: string,
  reports: ParsedReport[],
  rewrite: (text: string, r: ParsedReport) => string,
): string | null {
  const blocks: string[] = [];
  for (const r of reports) {
    const body = r.sections.get(sectionName);
    if (!body?.trim()) continue;
    blocks.push(`### From ${r.label}\n\n${rewrite(body, r)}`);
  }
  return blocks.length ? [`## ${sectionName}`, "", ...blocks].join("\n\n") : null;
}

/**
 * Merge survey-mode subagent reports into one report via deterministic table union +
 * citation remap. Prose sections are concatenated with attribution (callers may replace
 * them with a constrained LLM pass). Returns merged markdown + coverage stats.
 */
export function mergeSurveyReports(inputs: SurveyReportInput[]): SurveyMergeResult {
  const reports = inputs.map(parseReport);
  const { globalOrder, rewrite } = buildCitationRemapper(reports);

  const execCandidates = reports
    .map((r) => ({ r, body: r.sections.get("Executive Summary") ?? "" }))
    .sort((a, b) => b.body.length - a.body.length);
  const execBody = execCandidates[0]?.body ? rewrite(execCandidates[0].body, execCandidates[0].r) : "";

  const title = reports.find((r) => r.title)?.title ?? "Survey";
  const parts: string[] = [`# ${title}`, "", "## Executive Summary", "", execBody];

  const stats: SurveyMergeStats = { systems: 0, benchmarks: 0, literature: 0, sources: globalOrder.length };
  const statKeys: (keyof SurveyMergeStats)[] = ["systems", "benchmarks", "literature"];

  SURVEY_TABLE_SECTIONS.forEach((section, i) => {
    const merged = mergeTable(section, reports, rewrite);
    if (merged) {
      parts.push("", merged.markdown);
      stats[statKeys[i]] = merged.rows;
    }
  });

  for (const section of PROSE_SECTIONS) {
    const merged = concatProse(section, reports, rewrite);
    if (merged) parts.push("", merged);
  }

  parts.push("", "## Sources", "");
  globalOrder.forEach((url, i) => parts.push(`${i + 1}. ${url}`));

  return { markdown: parts.join("\n") + "\n", stats };
}
