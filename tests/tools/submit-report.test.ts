// ABOUTME: Tests for the submit_report tool.
// ABOUTME: Verifies the report is captured in the shared ref and the tool result is well-formed.

import { describe, it, expect } from "vitest";
import {
  createSubmitReportTool,
  type SubmittedReportRef,
} from "../../src/tools/submit-report.js";

describe("createSubmitReportTool", () => {
  it("stores the submitted report in the shared ref", async () => {
    const ref: SubmittedReportRef = { value: null };
    const tool = createSubmitReportTool(ref);

    const report = "# Title\n\nBody with [1] citation.\n\n## Sources\n1. https://example.com";
    await tool.execute("call-1", { report });

    expect(ref.value).toBe(report);
  });

  it("trims whitespace around the submitted report", async () => {
    const ref: SubmittedReportRef = { value: null };
    const tool = createSubmitReportTool(ref);

    await tool.execute("call-1", { report: "   \n\n# Report body   \n\n" });

    expect(ref.value).toBe("# Report body");
  });

  it("overwrites prior submissions (last write wins)", async () => {
    const ref: SubmittedReportRef = { value: "previous content" };
    const tool = createSubmitReportTool(ref);

    await tool.execute("call-1", { report: "new content" });
    expect(ref.value).toBe("new content");

    await tool.execute("call-2", { report: "newer content" });
    expect(ref.value).toBe("newer content");
  });

  it("returns confirmation text with the report length and a stop hint", async () => {
    const ref: SubmittedReportRef = { value: null };
    const tool = createSubmitReportTool(ref);

    const report = "x".repeat(1234);
    const result = await tool.execute("call-1", { report });

    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("1234"),
      }),
    );
    expect(result.content[0].text).toMatch(/end your turn/i);
  });

  it("exposes the report length via details", async () => {
    const ref: SubmittedReportRef = { value: null };
    const tool = createSubmitReportTool(ref);

    const result = await tool.execute("call-1", { report: "hello world" });
    expect(result.details).toEqual({ reportLength: "hello world".length });
  });
});
