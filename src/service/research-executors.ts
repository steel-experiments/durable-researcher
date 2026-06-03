// ABOUTME: Executor registry for ResearchRun harness strategies.
// ABOUTME: Implements campaign, single-agent, fixed-team, and subagent-style runs over durable research tasks.

import { createHash } from "node:crypto";
import { createResearchApp } from "../agent.js";
import { getMaxDurationSeconds } from "../config.js";
import {
  compileCampaignReport,
  createCampaign,
  finalizeCampaign,
  getCampaign,
  listCampaignPulses,
  pauseCampaign,
  runCampaign,
  usageFromAgentUsage,
} from "../campaign.js";
import type { CampaignUsage, ResearchNote, ResearchParams, ResearchResult } from "../types.js";
import { badRequest } from "./research-errors.js";
import type { ExecutableHarness } from "./research-harness.js";
import type { ResearchRun } from "./research-runs.js";
import {
  createResearchRunTask,
  listResearchRunTasks,
  updateResearchRunTask,
  type ResearchRunTask,
} from "./research-tasks.js";
import { saveResearchArtifact } from "./research-artifacts.js";
import { mergeSurveyParts, assembleSurvey } from "../survey-merge.js";
import { refineSurveyProse } from "../survey-prose.js";
import { parseWorkstreams } from "./workstreams.js";
import { critiqueCompleteness } from "./completeness-critic.js";

export type ExecutorContext = {
  signal: AbortSignal;
  setRunStatus(status: ResearchRun["status"]): Promise<void>;
  setRunCampaign(campaignId: string, status: ResearchRun["status"]): Promise<void>;
};

export type ResearchExecutor = {
  start(run: ResearchRun, ctx: ExecutorContext): Promise<void>;
  pause?(run: ResearchRun, ctx: ExecutorContext): Promise<void>;
  resume?(run: ResearchRun, ctx: ExecutorContext): Promise<void>;
  finalize?(run: ResearchRun, ctx: ExecutorContext): Promise<string>;
};

function queueName(runId: string, role: string): string {
  const hash = createHash("sha1").update(`${runId}:${role}`).digest("hex").slice(0, 12);
  return `run_${hash}_${role.replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}`;
}

function taskTokenLimit(harness: ExecutableHarness | undefined, role: "agent" | "subagent" | "synthesis"): number | undefined {
  if (!harness) return undefined;
  if (role === "synthesis") return harness.type === "fixed_team" || harness.type === "async_subagents" || harness.type === "orchestrator_blocking_subagents"
    ? harness.totalTokenLimit
    : undefined;
  if (harness.type === "fixed_team") return harness.perAgentTokenLimit;
  if (harness.type === "async_subagents" || harness.type === "orchestrator_blocking_subagents") return harness.perSubagentTokenLimit;
  return undefined;
}

async function runResearchTask(input: {
  run: ResearchRun;
  harnessType: string;
  role: string;
  objective: string;
  params: ResearchParams;
  signal?: AbortSignal;
}): Promise<{ task: ResearchRunTask; result: ResearchResult; usage: CampaignUsage }> {
  throwIfAborted(input.signal);
  const task = await createResearchRunTask({
    runId: input.run.id,
    role: input.role,
    harnessType: input.harnessType,
    objective: input.objective,
  });
  const q = queueName(input.run.id, input.role);
  const app = createResearchApp({ queueName: q, quiet: true });
  try {
    await app.createQueue();
    const spawned = await app.spawn("research", input.params);
    await updateResearchRunTask(task.id, {
      status: "running",
      taskId: spawned.taskID,
      queueName: q,
      startedAt: new Date(),
    });
    // Claim timeout MUST cover the task's full max runtime. A research task runs up to
    // getMaxDurationSeconds(depth) (standard 30m / deep 60m); the prior hardcoded 600s
    // (10m) meant any subagent running past 10m had its claim expire, and past 20m Absurd
    // TERMINATED the worker process — crashing the whole API server mid-run.
    const taskMaxSeconds = getMaxDurationSeconds(input.params.depth);
    const worker = await app.startWorker({ concurrency: 1, claimTimeout: taskMaxSeconds + 120 });
    let state;
    try {
      state = await raceAbort(
        app.awaitTaskResult(spawned.taskID, {
          queue: q,
          timeout: taskMaxSeconds + 30,
        }),
        input.signal,
      );
    } finally {
      await worker.close();
    }
    if (state.state !== "completed" || !state.result) {
      await updateResearchRunTask(task.id, { status: "failed", endedAt: new Date() });
      const failure = state.state === "failed" ? state.failure : state.state;
      throw new Error(`Research task failed: ${JSON.stringify(failure)}`);
    }
    const result = state.result as unknown as ResearchResult;
    const usage = usageFromAgentUsage((app as any).getLastUsage?.(), result.sources?.length ?? 0);
    await updateResearchRunTask(task.id, {
      status: "completed",
      result,
      usage,
      endedAt: new Date(),
    });
    await saveResearchArtifact({
      runId: input.run.id,
      kind: `${input.role}-report`,
      contentType: "text/markdown",
      content: result.report,
      metadata: { taskId: spawned.taskID, harnessType: input.harnessType },
    });
    return { task, result, usage };
  } catch (err) {
    const status = isAbortError(err) ? "cancelled" : "failed";
    await updateResearchRunTask(task.id, { status, endedAt: new Date() }).catch(() => undefined);
    throw err;
  } finally {
    await app.close();
  }
}

function abortError(): Error {
  const err = new Error("Research run stopped");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function mergeSources(results: ResearchResult[]): { title: string; url: string }[] {
  const byUrl = new Map<string, { title: string; url: string }>();
  for (const result of results) {
    for (const source of result.sources ?? []) {
      if (!byUrl.has(source.url)) byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}

function mergeNotes(results: ResearchResult[]): ResearchNote[] {
  return results.flatMap((result) => result.notes ?? []);
}

function teamObjectives(topic: string, count: number): string[] {
  const base = [
    `Find primary sources, official documentation, papers, filings, and original data for: ${topic}`,
    `Find benchmarks, metrics, quantitative comparisons, and empirical evidence for: ${topic}`,
    `Find criticism, limitations, counterarguments, failures, and negative evidence for: ${topic}`,
    `Build a timeline, key actors map, and dependency graph for: ${topic}`,
    `Synthesize practical implications, tradeoffs, and decision criteria for: ${topic}`,
  ];
  return Array.from({ length: count }, (_, i) => base[i] ?? `Investigate independent angle ${i + 1} for: ${topic}`);
}

function synthPrompt(topic: string, results: ResearchResult[], harnessType: string): string {
  return [
    `Synthesize the final answer for a ${harnessType} research run.`,
    `Topic: ${topic}`,
    "Use only the provided prior notes and source URLs. Preserve numeric citations and include a numbered Sources section.",
    "",
    "Agent reports:",
    ...results.map((result, index) => [
      `## Agent ${index + 1}`,
      result.report,
    ].join("\n")),
  ].join("\n");
}

async function synthesizeTeam(
  run: ResearchRun,
  harnessType: string,
  results: ResearchResult[],
  signal?: AbortSignal,
): Promise<ResearchResult> {
  const sources = mergeSources(results);
  const notes = mergeNotes(results);

  // Merge the subagents' reports DETERMINISTICALLY when they're survey-shaped. The
  // free-form LLM synthesis below collapsed four good 21-25KB survey reports into a
  // 258-char meta-acknowledgement; survey reports are table-structured, so union +
  // citation-remap preserves every subagent's work at zero token cost.
  //
  // We detect survey shape from the REPORTS, not run.params.mode — the run-level mode
  // is often unset (null) while the subagents independently classify as survey and emit
  // the tables. mergeSurveyReports reports how many table rows it found; if it found any,
  // the reports were genuinely survey-shaped and the merge is valid. Otherwise fall back.
  const parts = mergeSurveyParts(
    results.map((result, index) => ({ label: `Subagent ${index + 1}`, report: result.report ?? "" })),
  );
  if (parts.stats.systems + parts.stats.benchmarks + parts.stats.literature > 0) {
    // Tables + sources are always deterministic. The prose sections (Cross-Cutting,
    // Gaps) get a constrained LLM pass that unifies the per-subagent concatenation into
    // one coherent section; it can't touch tables/sources and falls back to the concat
    // if it collapses or fails. So the worst case is the proven deterministic merge.
    let proseOverride: Record<string, string> = {};
    try {
      proseOverride = await refineSurveyProse(parts);
    } catch {
      // Keep deterministic concat for all prose.
    }
    const markdown = assembleSurvey(parts, proseOverride);
    await saveResearchArtifact({
      runId: run.id,
      kind: "final-report",
      contentType: "text/markdown",
      content: markdown,
      metadata: {
        harnessType,
        sourceReports: results.length,
        merge: "deterministic",
        proseRefined: Object.keys(proseOverride),
        stats: parts.stats,
      },
    });
    return { topic: run.topic, report: markdown, notes, sources, messages: [], mode: "survey" };
  }
  // Reports weren't table-structured — use LLM synthesis.

  const synthesis = await runResearchTask({
    run,
    harnessType,
    role: "synthesis",
    objective: `Synthesize final report for ${run.topic}`,
    signal,
    params: {
      topic: run.topic,
      depth: run.params.depth,
      maxSources: sources.length,
      priorNotes: notes,
      priorUrls: sources.map((s) => s.url),
      mode: run.params.mode,
      clarifications: run.params.clarify,
      maxTokens: taskTokenLimit(run.params.selectedHarness, "synthesis"),
      extensionInstruction: synthPrompt(run.topic, results, harnessType),
    },
  });
  await saveResearchArtifact({
    runId: run.id,
    kind: "final-report",
    contentType: "text/markdown",
    content: synthesis.result.report,
    metadata: { harnessType, sourceReports: results.length, merge: "llm" },
  });
  return synthesis.result;
}

async function runTeam(
  run: ResearchRun,
  harnessType: string,
  objectives: string[],
  signal?: AbortSignal,
): Promise<void> {
  const tasks = await Promise.all(objectives.map((objective, index) =>
    runResearchTask({
      run,
      harnessType,
      role: `agent-${index + 1}`,
      objective,
      signal,
      params: {
        topic: run.topic,
        depth: run.params.depth,
        mode: run.params.mode,
        clarifications: run.params.clarify,
        maxSources: run.params.budgets.maxSources,
        maxTokens: taskTokenLimit(run.params.selectedHarness, harnessType === "fixed_team" ? "agent" : "subagent"),
        extensionInstruction: objective,
        // Quarantine: fan-out subagents read untrusted web content, so they must not
        // hold the code-adapter tools. The synthesis step works only from their notes.
        allowAdapters: false,
      },
    })
  ));
  const synthesized = await synthesizeTeam(run, harnessType, tasks.map((task) => task.result), signal);

  // Completeness critic: one pass over the synthesized report to name coverage gaps the
  // fan-out missed. Recorded as an artifact only — it never blocks or rewrites here.
  const critique = await critiqueCompleteness({
    topic: run.topic,
    report: synthesized.report ?? "",
    objectives,
  }).catch(() => null);
  if (critique) {
    await saveResearchArtifact({
      runId: run.id,
      kind: "completeness-critique",
      contentType: "application/json",
      content: JSON.stringify(critique, null, 2),
      metadata: {
        harnessType,
        coverageComplete: critique.coverageComplete,
        gapCount: critique.gaps.length,
      },
    }).catch(() => undefined);
  }
}

export function createCampaignPulsesExecutor(): ResearchExecutor {
  return {
    async start(run, ctx) {
      let campaignId = run.campaignId;
      if (!campaignId) {
        const campaign = await createCampaign({
          topic: run.topic,
          depth: run.params.depth,
          pulseDepth: run.params.pulseDepth ?? run.params.depth,
          pulseMaxSources: run.params.pulseMaxSources,
          mode: run.params.mode,
          clarify: run.params.clarify,
          budgets: run.params.budgets,
          stopWhenGoalMet: run.params.stopWhenGoalMet ?? true,
          stopWhenExhaustedSources: run.params.stopWhenExhaustedSources ?? true,
        });
        campaignId = campaign.id;
        await ctx.setRunCampaign(campaign.id, "running");
      }
      const campaign = await runCampaign(campaignId, { quiet: true, signal: ctx.signal });
      await ctx.setRunStatus(campaign.status);
      if (campaign.finalReport) {
        await saveResearchArtifact({
          runId: run.id,
          kind: "final-report",
          contentType: "text/markdown",
          content: campaign.finalReport,
          metadata: { campaignId },
        });
      }
    },
    async pause(run, ctx) {
      if (!run.campaignId) throw badRequest("Research run is not linked to a campaign yet");
      await pauseCampaign(run.campaignId);
      await ctx.setRunStatus("paused");
    },
    async resume(run, ctx) {
      await ctx.setRunStatus("running");
      await this.start(run, ctx);
    },
    async finalize(run, ctx) {
      if (!run.campaignId) throw badRequest("Research run is not linked to a campaign yet");
      const report = await finalizeCampaign(run.campaignId, "manual finalization requested");
      await ctx.setRunStatus("completed");
      await saveResearchArtifact({
        runId: run.id,
        kind: "final-report",
        contentType: "text/markdown",
        content: report,
        metadata: { campaignId: run.campaignId },
      });
      return report;
    },
  };
}

export function createSingleAgentExecutor(): ResearchExecutor {
  return {
    async start(run, ctx) {
      await runResearchTask({
        run,
        harnessType: "single_agent",
        role: "single-agent",
        objective: run.topic,
        signal: ctx.signal,
        params: {
          topic: run.topic,
          depth: run.params.depth,
          maxSources: run.params.budgets.maxSources,
          maxTokens: run.params.selectedHarness?.type === "single_agent"
            ? run.params.budgets.maxTokens
            : undefined,
          mode: run.params.mode,
          clarifications: run.params.clarify,
        },
      }).then(async ({ result }) => {
        await saveResearchArtifact({
          runId: run.id,
          kind: "final-report",
          contentType: "text/markdown",
          content: result.report,
          metadata: { harnessType: "single_agent" },
        });
      });
      await ctx.setRunStatus("completed");
    },
  };
}

export function createFixedTeamExecutor(): ResearchExecutor {
  return {
    async start(run, ctx) {
      const harness = run.params.selectedHarness;
      const agents = harness?.type === "fixed_team" ? harness.agents : 5;
      await runTeam(run, "fixed_team", teamObjectives(run.topic, agents), ctx.signal);
      await ctx.setRunStatus("completed");
    },
  };
}

export function createAsyncSubagentsExecutor(): ResearchExecutor {
  return {
    async start(run, ctx) {
      const harness = run.params.selectedHarness;
      const count = harness?.type === "async_subagents" ? harness.maxSubagents : 5;
      const objectives = teamObjectives(run.topic, count).map((objective, index) =>
        `Async subagent ${index + 1}: ${objective}. Work independently; the orchestrator will merge your findings.`
      );
      await runTeam(run, "async_subagents", objectives, ctx.signal);
      await ctx.setRunStatus("completed");
    },
  };
}

export function createBlockingSubagentsExecutor(): ResearchExecutor {
  return {
    async start(run, ctx) {
      const harness = run.params.selectedHarness;
      const count = harness?.type === "orchestrator_blocking_subagents" ? harness.maxSubagents : 5;
      const plan = await runResearchTask({
        run,
        harnessType: "orchestrator_blocking_subagents",
        role: "orchestrator-plan",
        objective: `Plan quality-first subagent research for ${run.topic}`,
        signal: ctx.signal,
        params: {
          topic: run.topic,
          depth: "quick",
          mode: run.params.mode,
          clarifications: run.params.clarify,
          extensionInstruction: [
            `Create a concise research plan identifying up to ${count} independent subagent workstreams.`,
            `Output each workstream on its own line beginning with "WORKSTREAM: " followed by a specific,`,
            `self-contained research objective tailored to this topic. Make the workstreams genuinely`,
            `non-overlapping so subagents do not duplicate each other's work.`,
            `Do not write the final report yet.`,
          ].join(" "),
        },
      });
      // Let the orchestrator's decomposition drive the fan-out. Fall back to the generic
      // angle list only when the plan didn't yield at least two usable workstreams.
      const planned = parseWorkstreams(plan.result.report ?? "", count);
      const objectives = planned.length >= 2
        ? planned.map((objective, index) =>
            `Blocking subagent ${index + 1}: ${objective}\n\nUse this orchestrator context:\n${plan.result.report}`)
        : teamObjectives(run.topic, count).map((objective, index) =>
            `Blocking subagent ${index + 1}: ${objective}. Use this orchestrator context:\n${plan.result.report}`);
      await runTeam(run, "orchestrator_blocking_subagents", objectives, ctx.signal);
      await ctx.setRunStatus("completed");
    },
  };
}

export function executorForHarness(harness: ExecutableHarness): ResearchExecutor {
  switch (harness.type) {
    case "campaign_pulses":
      return createCampaignPulsesExecutor();
    case "single_agent":
      return createSingleAgentExecutor();
    case "fixed_team":
      return createFixedTeamExecutor();
    case "async_subagents":
      return createAsyncSubagentsExecutor();
    case "orchestrator_blocking_subagents":
      return createBlockingSubagentsExecutor();
  }
}

export async function campaignPulsesAsTasks(run: ResearchRun): Promise<ResearchRunTask[]> {
  if (!run.campaignId) return [];
  const campaign = await getCampaign(run.campaignId);
  if (!campaign) return [];
  const pulses = await listCampaignPulses(run.campaignId);
  return pulses.map((pulse) => ({
    id: `campaign_pulse_${pulse.id}`,
    runId: run.id,
    role: `pulse-${pulse.pulseIndex + 1}`,
    harnessType: "campaign_pulses",
    taskId: pulse.taskId,
    queueName: pulse.queueName,
    status: pulse.status,
    objective: pulse.objective,
    result: pulse.result,
    usage: pulse.usage,
    startedAt: pulse.startedAt,
    endedAt: pulse.endedAt,
    createdAt: pulse.startedAt,
  }));
}

export async function latestTaskReport(run: ResearchRun): Promise<string | null> {
  const tasks = await listResearchRunTasks(run.id);
  return [...tasks].reverse().find((task) => task.result?.report)?.result?.report ?? null;
}
