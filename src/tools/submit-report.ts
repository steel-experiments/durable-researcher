// ABOUTME: submit_report tool — captures the final research report as a tool call argument
// ABOUTME: so it survives across follow-up assistant messages and is recoverable on resume.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

/** Mutable holder for the most recently submitted report. */
export type SubmittedReportRef = { value: string | null };

const SubmitReportParams = Type.Object({
  report: Type.String({
    description:
      "The complete final research report, in markdown. Include every section, all citations [n], and the Sources list. Do NOT summarize or abbreviate.",
  }),
});

/**
 * Create a `submit_report` tool that records the final report into the provided ref.
 *
 * The tool is intended for cases where the model needs to deliver a long-form
 * deliverable that should NOT be confused with any trailing chat-style message
 * (e.g. after a citation-verification rewrite). On a normal first-pass run the
 * model can still emit the report as plain text — `buildResult` falls back to
 * the last text-only assistant message when this tool was not used.
 */
export function createSubmitReportTool(
  ref: SubmittedReportRef,
): AgentTool<typeof SubmitReportParams> {
  return {
    name: "submit_report",
    label: "Submit Report",
    description:
      "Record the final research report as the task deliverable. Call this exactly once when the report is complete. After calling, end your turn — do NOT call any further tools or write additional commentary.",
    parameters: SubmitReportParams,
    execute: async (_toolCallId, params) => {
      const report = params.report.trim();
      ref.value = report;
      return {
        content: [
          {
            type: "text" as const,
            text: `Report submitted (${report.length} chars). End your turn — no further tool calls or commentary needed.`,
          },
        ],
        details: { reportLength: report.length },
      };
    },
  };
}
