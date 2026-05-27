// ABOUTME: File-system output for finished reports and stdout helpers for the CLI.
// ABOUTME: Pure helpers — no Postgres, no agent state.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { UsageStats } from "./durable-turns.js";
import type {
  ArtifactSpec,
  Evidence,
  EvidenceExcerpt,
  ExplanationModel,
  ExplanationSource,
  ResearchResult,
} from "./types.js";

/** Turn a topic string into a filesystem-safe slug, capped at 60 chars. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function ensureOutputDir(): string {
  const outputDir = resolve(process.cwd(), "output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

function outputBasePath(topic: string): string {
  const outputDir = ensureOutputDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(outputDir, `${slugify(topic)}-${timestamp}`);
}

/** Write a report to ./output/<slug>-<timestamp>.md and return the path. */
export function saveReport(topic: string, report: string): string {
  const filepath = `${outputBasePath(topic)}.md`;
  writeFileSync(filepath, `# ${topic}\n\n${report}\n`);
  return filepath;
}

export type SavedResearchResult = {
  markdownPath: string;
  htmlPath?: string;
};

/** Write Markdown plus an HTML rendering (and any explanation artifacts) beside it. */
export function saveResearchResult(result: ResearchResult): SavedResearchResult {
  const base = outputBasePath(result.topic);
  const markdownPath = `${base}.md`;
  writeFileSync(markdownPath, `# ${result.topic}\n\n${result.report}\n`);

  // Always emit HTML alongside the Markdown. The renderer produces a full report
  // page for every mode; extraction runs additionally get evidence-table artifacts.
  const htmlPath = `${base}.html`;
  writeFileSync(htmlPath, renderResearchResultHtml(result));
  return { markdownPath, htmlPath };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function isSafeHref(value: string): boolean {
  return /^(https?:|mailto:)/i.test(value);
}

function renderInlineMarkdown(value: string): string {
  const codeSpans: string[] = [];
  let rendered = escapeHtml(value).replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = codeSpans.push(`<code>${code}</code>`) - 1;
    return `\u0000CODE${index}\u0000`;
  });

  rendered = rendered.replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const unescapedHref = href
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'");
    if (!isSafeHref(unescapedHref)) {
      return label;
    }
    return `<a href="${escapeAttribute(unescapedHref)}">${label}</a>`;
  });
  rendered = rendered
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  return rendered.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderMarkdownTable(lines: string[], startIndex: number): { html: string; nextIndex: number } | null {
  if (startIndex + 1 >= lines.length || !lines[startIndex].includes("|") || !isMarkdownTableSeparator(lines[startIndex + 1])) {
    return null;
  }

  const headers = parseMarkdownTableRow(lines[startIndex]);
  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
    rows.push(parseMarkdownTableRow(lines[index]));
    index += 1;
  }

  const thead = `<thead><tr>${headers.map((header) => `<th>${renderInlineMarkdown(header)}</th>`).join("")}</tr></thead>`;
  const tbody = rows.length
    ? `<tbody>${rows.map((row) => `<tr>${headers.map((_header, cellIndex) => `<td>${renderInlineMarkdown(row[cellIndex] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>`
    : "";
  return { html: `<table>${thead}${tbody}</table>`, nextIndex: index };
}

function renderMarkdownList(lines: string[], startIndex: number): { html: string; nextIndex: number } | null {
  const ordered = /^\s*\d+\.\s+/.test(lines[startIndex]);
  const unordered = /^\s*[-*]\s+/.test(lines[startIndex]);
  if (!ordered && !unordered) {
    return null;
  }

  const items: string[] = [];
  let index = startIndex;
  const marker = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
  while (index < lines.length && marker.test(lines[index])) {
    items.push(`<li>${renderInlineMarkdown(lines[index].replace(marker, ""))}</li>`);
    index += 1;
  }
  return { html: `<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`, nextIndex: index };
}

function renderReportMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      index += index < lines.length ? 1 : 0;
      continue;
    }

    const table = renderMarkdownTable(lines, index);
    if (table) {
      flushParagraph();
      html.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const list = renderMarkdownList(lines, index);
    if (list) {
      flushParagraph();
      html.push(list.html);
      index = list.nextIndex;
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      html.push("<hr>");
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${quote.map(renderInlineMarkdown).join("<br>")}</blockquote>`);
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return html.join("\n");
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function renderArtifact(artifact: ArtifactSpec, explanation: ExplanationModel): string {
  if (artifact.kind !== "extraction_evidence_table") {
    return "";
  }

  const evidenceById = new Map(explanation.evidence.map((item) => [item.id, item]));
  const excerptById = new Map(explanation.excerpts.map((item) => [item.id, item]));
  const sourceById = new Map(explanation.sources.map((item) => [item.id, item]));

  const rows = artifact.rows.map((row) => {
    const evidence: Evidence[] = row.evidenceIds.map((id) => evidenceById.get(id)).filter(isPresent);
    const excerpts: EvidenceExcerpt[] = row.excerptIds.map((id) => excerptById.get(id)).filter(isPresent);
    const sources: ExplanationSource[] = row.sourceIds.map((id) => sourceById.get(id)).filter(isPresent);
    const fields = row.fields ?? [];
    const missing = row.missingFields.length
      ? `<span class="missing">${escapeHtml(row.missingFields.join(", "))}</span>`
      : `<span class="ok">complete</span>`;
    return `
      <tr>
        <td><strong>${escapeHtml(row.label)}</strong></td>
        <td>${fields.map((field) => `<div><span class="field-label">${escapeHtml(field.label)}</span> ${escapeHtml(field.value)}</div>`).join("")}</td>
        <td><span class="confidence ${row.confidence}">${row.confidence}</span></td>
        <td>${sources.map((source) => `<a href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a>`).join("<br>")}</td>
        <td>${missing}</td>
      </tr>
      <tr class="detail">
        <td colspan="5">
          <details>
            <summary>View evidence</summary>
            ${evidence.map((item) => `<p>${escapeHtml(item.content)}</p>`).join("")}
            ${excerpts.map((excerpt) => `<blockquote>${escapeHtml(excerpt.text)}</blockquote>`).join("")}
          </details>
        </td>
      </tr>
    `;
  }).join("");

  return `
    <section>
      <h2>${escapeHtml(artifact.title)}</h2>
      <table>
        <thead>
          <tr>
            <th>Finding</th>
            <th>Extracted Values</th>
            <th>Confidence</th>
            <th>Sources</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

export function renderResearchResultHtml(result: ResearchResult): string {
  const explanation = result.explanation;
  const artifactHtml = explanation?.recommendedViews
    .map((artifact) => renderArtifact(artifact, explanation))
    .join("\n") ?? "";
  const visibleUncertainties = explanation?.uncertainties.slice(0, 4) ?? [];
  const hiddenUncertaintyCount = Math.max(0, (explanation?.uncertainties.length ?? 0) - visibleUncertainties.length);
  const uncertainties = visibleUncertainties.length
    ? `<section><h2>Uncertainties</h2><ul>${visibleUncertainties.map((item) => `<li>${escapeHtml(item.description)}</li>`).join("")}${hiddenUncertaintyCount ? `<li>${hiddenUncertaintyCount} more verification caveats omitted from this preview.</li>` : ""}</ul></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(result.topic)}</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #18202a; background: #f7f8fa; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
    h1 { font-size: 30px; line-height: 1.2; margin: 0 0 18px; }
    h2 { font-size: 20px; margin: 32px 0 12px; }
    section { margin-top: 22px; }
    .answer, .report, pre { background: #fff; border: 1px solid #d8dde5; border-radius: 8px; padding: 16px; }
    .answer { font-size: 16px; line-height: 1.55; }
    .report { line-height: 1.6; }
    .report h2 { font-size: 24px; margin: 10px 0 12px; }
    .report h3 { font-size: 19px; margin: 26px 0 10px; }
    .report h4 { font-size: 16px; margin: 20px 0 8px; }
    .report p { margin: 0 0 14px; }
    .report ul, .report ol { margin: 0 0 16px 24px; padding: 0; }
    .report li { margin: 5px 0; }
    .report code { background: #eef2f6; border: 1px solid #d8dde5; border-radius: 4px; padding: 1px 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
    .report pre code { background: transparent; border: 0; padding: 0; }
    .report hr { border: 0; border-top: 1px solid #d8dde5; margin: 24px 0; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8dde5; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px; border-bottom: 1px solid #e6e9ef; text-align: left; vertical-align: top; }
    th { background: #edf1f5; font-size: 13px; color: #4b5868; }
    .field-label { display: inline-block; min-width: 58px; color: #4b5868; font-size: 13px; font-weight: 700; }
    a { color: #1260a8; }
    blockquote { margin: 10px 0 0; padding: 8px 12px; border-left: 3px solid #9aa8b8; background: #f5f7fa; }
    summary { cursor: pointer; font-weight: 600; }
    pre { white-space: pre-wrap; line-height: 1.5; overflow-wrap: anywhere; }
    .confidence { display: inline-block; min-width: 56px; padding: 2px 8px; border-radius: 999px; font-size: 12px; text-align: center; border: 1px solid transparent; }
    .confidence.high { background: #e7f6ed; border-color: #98d4aa; color: #1f6f3a; }
    .confidence.medium { background: #fff5d9; border-color: #e0c56d; color: #765a00; }
    .confidence.low, .missing { background: #fdeceb; border-color: #e6aaa5; color: #8c2d25; }
    .ok { color: #2e6c3e; }
    .detail td { background: #fbfcfd; color: #354253; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(result.topic)}</h1>
    ${explanation ? `<section><h2>Answer</h2><div class="answer">${escapeHtml(explanation.answer)}</div></section>` : ""}
    ${artifactHtml}
    ${uncertainties}
    <section>
      <h2>Report</h2>
      <div class="report">${renderReportMarkdown(result.report)}</div>
    </section>
  </main>
</body>
</html>
`;
}

/** Print a tidy token-usage summary to stdout. */
export function printUsage(usage: UsageStats): void {
  console.log("\n--- Token Usage ---");
  console.log(
    `Total: ${usage.inputTokens.toLocaleString()} input, ${usage.outputTokens.toLocaleString()} output`,
  );
  if (usage.cacheReadTokens > 0) {
    console.log(`Cache reads: ${usage.cacheReadTokens.toLocaleString()}`);
  }
  for (const [model, counts] of Object.entries(usage.models)) {
    console.log(
      `  ${model}: ${counts.input.toLocaleString()} in / ${counts.output.toLocaleString()} out`,
    );
  }
}
