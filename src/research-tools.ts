// ABOUTME: Builds the agent tool set for a research task.
// ABOUTME: Keeps mode/depth-specific tool wiring out of the durable agent loop.

import Steel from "steel-sdk";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResearchNote, TaskMode } from "./types.js";
import { createSearchTool } from "./tools/search.js";
import { createBrowseTool } from "./tools/browse.js";
import { createScreenshotTool } from "./tools/screenshot.js";
import { createNoteTool } from "./tools/note.js";
import { createWriteAdapterTool } from "./tools/write-adapter.js";
import { createUseAdapterTool } from "./tools/use-adapter.js";
import { createSubmitReportTool, type SubmittedReportRef } from "./tools/submit-report.js";
import { createEvaluateTool } from "./tools/evaluate.js";
import { createPlanTool } from "./tools/plan.js";
import { createPrefetchTool } from "./tools/prefetch.js";
import { createScoutTool } from "./tools/scout.js";
import { createGapAnalysisTool } from "./tools/gap-analysis.js";
import { createFindEntityTool } from "./tools/find-entity.js";
import { createChaseReferencesTool } from "./tools/chase-references.js";
import { createReferenceQueue } from "./reference-queue.js";
import type { ResearchParams } from "./types.js";
import type { ToolProgress } from "./event-bus.js";
import type { UrlExcerptStore } from "./url-excerpts.js";

export type ResearchToolOptions = {
  client: Steel;
  scrapedUrls: Set<string>;
  notes: ResearchNote[];
  params: ResearchParams;
  mode: TaskMode;
  maxSources: number;
  gapPasses: number;
  taskId: string;
  progress?: ToolProgress;
  urlExcerpts: UrlExcerptStore;
  /**
   * Whether to expose the code-adapter tools. Defaults to true. When false (e.g. for
   * fan-out subagents that browse untrusted pages), write_adapter/use_adapter are
   * withheld so page content cannot escalate into code execution.
   */
  allowAdapters?: boolean;
};

export function createResearchTools(opts: ResearchToolOptions): AgentTool<any>[] {
  const {
    client,
    scrapedUrls,
    notes,
    params,
    mode,
    maxSources,
    gapPasses,
    taskId,
    progress,
    urlExcerpts,
  } = opts;
  const allowAdapters = opts.allowAdapters !== false;
  const prefetchBudget = Math.floor(maxSources / 2);
  const referenceChasingEnabled = mode === "survey";
  const referenceQueue = createReferenceQueue(scrapedUrls);
  const submittedReport: SubmittedReportRef = { value: null };

  return [
    createSubmitReportTool(submittedReport),
    createPlanTool(params, mode, progress),
    createPrefetchTool(client, scrapedUrls, params.topic, prefetchBudget, taskId, progress, urlExcerpts),
    createScoutTool(client, scrapedUrls, params.topic, taskId, progress, urlExcerpts, referenceQueue),
    createSearchTool(client, scrapedUrls, params.topic, mode),
    createBrowseTool(client, scrapedUrls, params.topic, taskId, urlExcerpts, referenceQueue),
    createScreenshotTool(client),
    createNoteTool(notes),
    createEvaluateTool(notes, scrapedUrls, mode),
    ...(gapPasses > 0
      ? [
          createGapAnalysisTool({ notes, topic: params.topic, maxCalls: gapPasses, progress }),
          createFindEntityTool(client, scrapedUrls, params.topic, taskId, progress, urlExcerpts),
        ]
      : []),
    ...(referenceChasingEnabled
      ? [
          createChaseReferencesTool(
            client,
            scrapedUrls,
            params.topic,
            referenceQueue,
            taskId,
            progress,
            urlExcerpts,
          ),
        ]
      : []),
    ...(allowAdapters
      ? [createUseAdapterTool(), createWriteAdapterTool()]
      : []),
  ];
}
