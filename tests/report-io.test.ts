// ABOUTME: Tests for report filesystem output and constrained HTML artifact rendering.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveResearchResult } from "../src/report-io.js";
import type { ResearchResult } from "../src/types.js";

describe("saveResearchResult", () => {
  let cwd: string;
  let tempDir: string;

  beforeEach(() => {
    cwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "durable-researcher-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a static HTML artifact for extraction evidence tables", () => {
    const result: ResearchResult = {
      topic: "ACME <Revenue>",
      report: [
        "# ACME Financials",
        "",
        "ACME reported <script>alert(1)</script> revenue with `verified` support.",
        "",
        "| Metric | Value |",
        "|---|---|",
        "| Revenue | $10m |",
      ].join("\n"),
      notes: [],
      sources: [],
      messages: [],
      mode: "extraction",
      explanation: {
        answer: "ACME revenue answer",
        claims: [],
        evidence: [
          {
            id: "evidence-1",
            title: "Revenue",
            content: "Revenue was $10m.",
            sourceUrls: ["https://example.com/report"],
            excerptIds: ["evidence-1-excerpt-1"],
            confidence: "high",
          },
        ],
        excerpts: [
          {
            id: "evidence-1-excerpt-1",
            evidenceId: "evidence-1",
            text: "Revenue: $10m",
            sourceUrl: "https://example.com/report",
          },
        ],
        sources: [
          {
            id: "source-1",
            title: "Annual Report",
            url: "https://example.com/report",
          },
        ],
        reasoningSteps: [],
        uncertainties: [],
        recommendedViews: [
          {
            kind: "extraction_evidence_table",
            title: "Evidence Table",
            rows: [
              {
                id: "row-evidence-1",
                label: "Revenue",
                fields: [{ label: "Value", value: "$10m" }],
                confidence: "high",
                sourceIds: ["source-1"],
                evidenceIds: ["evidence-1"],
                excerptIds: ["evidence-1-excerpt-1"],
                missingFields: [],
              },
            ],
          },
        ],
      },
    };

    const saved = saveResearchResult(result);

    expect(saved.markdownPath).toMatch(/\.md$/);
    expect(saved.htmlPath).toMatch(/\.html$/);
    const html = readFileSync(saved.htmlPath!, "utf8");
    expect(html).toContain("Evidence Table");
    expect(html).toContain("Extracted Values");
    expect(html).toContain("field-label");
    expect(html).toContain("<summary>View evidence</summary>");
    expect(html).toContain("Revenue: $10m");
    expect(html).toContain("<h2>ACME Financials</h2>");
    expect(html).toContain("<code>verified</code>");
    expect(html).toContain("<td>Revenue</td>");
    expect(html).not.toContain("# ACME Financials");
    expect(html).not.toContain("| Metric | Value |");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("writes an HTML rendering for non-extraction modes with no recommended views", () => {
    const result: ResearchResult = {
      topic: "State of agent steering",
      report: [
        "## Executive Summary",
        "",
        "Agents are hard to steer [1].",
        "",
        "### Sources",
        "1. https://example.com/paper",
      ].join("\n"),
      notes: [],
      sources: [],
      messages: [],
      mode: "survey",
      explanation: {
        answer: "Steering is immature.",
        claims: [],
        evidence: [],
        excerpts: [],
        sources: [],
        reasoningSteps: [],
        uncertainties: [],
        recommendedViews: [],
      },
    };

    const saved = saveResearchResult(result);

    expect(saved.markdownPath).toMatch(/\.md$/);
    expect(saved.htmlPath).toMatch(/\.html$/);
    const html = readFileSync(saved.htmlPath!, "utf8");
    expect(html).toContain("<h1>State of agent steering</h1>");
    expect(html).toContain("Agents are hard to steer");
    expect(html).toContain("<h2>Report</h2>");
  });

  it("still writes HTML when there is no explanation model at all", () => {
    const result: ResearchResult = {
      topic: "Lookup answer",
      report: "The answer is 42 [1].",
      notes: [],
      sources: [],
      messages: [],
      mode: "lookup",
    };

    const saved = saveResearchResult(result);

    expect(saved.htmlPath).toMatch(/\.html$/);
    const html = readFileSync(saved.htmlPath!, "utf8");
    expect(html).toContain("The answer is 42");
  });
});
