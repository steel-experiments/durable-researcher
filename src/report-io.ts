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

/** Write Markdown plus any constrained explanation artifacts beside it. */
export function saveResearchResult(result: ResearchResult): SavedResearchResult {
  const base = outputBasePath(result.topic);
  const markdownPath = `${base}.md`;
  writeFileSync(markdownPath, `# ${result.topic}\n\n${result.report}\n`);

  if (!result.explanation?.recommendedViews.length) {
    return { markdownPath };
  }

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
    const missing = row.missingFields.length
      ? `<span class="missing">${escapeHtml(row.missingFields.join(", "))}</span>`
      : `<span class="ok">complete</span>`;
    return `
      <tr>
        <td><strong>${escapeHtml(row.label)}</strong></td>
        <td><span class="confidence ${row.confidence}">${row.confidence}</span></td>
        <td>${sources.map((source) => `<a href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a>`).join("<br>")}</td>
        <td>${missing}</td>
      </tr>
      <tr class="detail">
        <td colspan="4">
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
  const uncertainties = explanation?.uncertainties.length
    ? `<section><h2>Uncertainties</h2><ul>${explanation.uncertainties.map((item) => `<li>${escapeHtml(item.description)}</li>`).join("")}</ul></section>`
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
    .answer, pre { background: #fff; border: 1px solid #d8dde5; border-radius: 8px; padding: 16px; }
    .answer { font-size: 16px; line-height: 1.55; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8dde5; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px; border-bottom: 1px solid #e6e9ef; text-align: left; vertical-align: top; }
    th { background: #edf1f5; font-size: 13px; color: #4b5868; }
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
      <pre>${escapeHtml(result.report)}</pre>
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
