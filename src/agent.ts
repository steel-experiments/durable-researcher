// ABOUTME: Absurd task registration and durable agent loop orchestration.
// ABOUTME: Registers a "research" task that runs a Pi Agent loop with checkpointed turns.

import { Absurd } from "absurd-sdk";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
} from "@mariozechner/pi-agent-core";
import { getEnvApiKey, type Model, type Api } from "@mariozechner/pi-ai";
import {
  getAgentModel,
  getAgentReasoning,
  getMaxDurationMs,
  getMaxDurationSeconds,
} from "./config.js";
import type { ResearchParams, ResearchResult, MessageLogEntry, TaskMode } from "./types.js";
import { DEPTH_CONFIG } from "./types.js";
import { classifyTask } from "./classify.js";
import { createSteelClient } from "./steel-client.js";
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
import {
  verifyClaims,
  shouldTriggerRewrite,
  buildRewriteSteering,
  isBetterVerification,
  VERIFY_PASS_THRESHOLD,
  type VerificationResult,
} from "./tools/verify-claims.js";
import {
  loadMessageLog,
  createLoggingPersister,
  rebuildStateFromMessages,
  type UsageStats,
} from "./durable-turns.js";
import { deduplicateNotes } from "./notes-ranker.js";
import { loadTemplate } from "./prompts.js";
import { convertToLlm } from "./agent-messages.js";
import type { ResearchEventBus } from "./event-bus.js";
import { createToolProgress } from "./event-bus.js";
import type { SteeringQueue } from "./steering-queue.js";
import { createUrlExcerptStore, rebuildUrlExcerptsFromCache } from "./url-excerpts.js";
import { getCachedBrowse, getTitlesForUrls } from "./browse-cache.js";
import { buildExplanationModel } from "./explanation.js";

/** Options for creating the research app. */
export type ResearchAppOptions = {
  databaseUrl?: string;
  model?: Model<Api>;
  queueName?: string;
  eventBus?: ResearchEventBus;
  steeringQueue?: SteeringQueue;
  quiet?: boolean;
};

/**
 * Resolve the effective task ID used for caching browse results.
 *
 * When `BENCH_CACHE_KEY` is set in the environment (e.g. `draco:<task_id>`), it
 * overrides the per-task Absurd `ctx.taskID`. This lets benchmark re-runs share
 * the browse cache across invocations: every Absurd run gets a fresh `taskID`,
 * so without the override the cache hit rate would be 0% on re-run.
 */
export function resolveCacheKey(ctxTaskId: string): string {
  const override = process.env.BENCH_CACHE_KEY;
  if (override && override.length > 0) return override;
  return ctxTaskId;
}

/** Drain user-supplied steering text into user messages for the next agent turn. */
export function drainUserSteering(queue?: SteeringQueue): AgentMessage[] {
  if (!queue) return [];
  return queue.drain().map((message) => ({
    role: "user" as const,
    content: `[USER STEERING]\n${message}`,
    timestamp: Date.now(),
  }));
}

/**
 * Generate a partial report from accumulated notes when the agent didn't
 * produce a final report (e.g. due to timeout).
 */
export function buildPartialReport(
  notes: { title: string; content: string; sourceUrls: string[] }[],
  topic: string,
): string {
  if (notes.length === 0) return "";

  const sections = notes.map(
    (n) =>
      `## ${n.title}\n${n.content}\n\nSources: ${n.sourceUrls.join(", ")}`,
  );

  return [
    `[Partial results — research timed out with ${notes.length} notes collected on "${topic}"]`,
    "",
    ...sections,
  ].join("\n\n");
}

/**
 * Create a timeout steering check that fires when elapsed time approaches the deadline.
 * Returns a function: call it each turn to check if the agent should stop.
 * The message is only returned once; subsequent calls return null message but shouldStop stays true.
 */
export function createTimeoutSteeringCheck(
  taskStartTime: number,
  maxDuration: number,
  timeoutBuffer: number,
): () => { shouldStop: boolean; message: string | null } {
  let messageSent = false;

  return () => {
    const elapsed = Date.now() - taskStartTime;
    if (elapsed < maxDuration - timeoutBuffer) {
      return { shouldStop: false, message: null };
    }

    if (messageSent) {
      return { shouldStop: true, message: null };
    }

    messageSent = true;
    return {
      shouldStop: true,
      message: `[SYSTEM] Approaching task timeout (${Math.round(elapsed / 1000)}s elapsed of ${Math.round(maxDuration / 1000)}s max). Stop ALL tool use immediately and write your final research report NOW using the notes you have collected. Use numeric inline citations like [1] and a numbered Sources section; do not use markdown author links as citations.`,
    };
  };
}

/** Build the final research result from accumulated notes and messages. */
export function buildResult(
  notes: { title: string; content: string; sourceUrls: string[]; confidence?: "high" | "medium" | "low"; keyExcerpts?: string[] }[],
  topic: string,
  messages: AgentMessage[],
  verification?: { result: VerificationResult; attempts: number; rewriteTriggered: boolean },
  mode: TaskMode = "synthesis",
  urlTitles: ReadonlyMap<string, string> = new Map(),
  /**
   * When the rewrite loop tracked a best-so-far report that beats whatever's
   * latest in the message log, pass it here so the final result reflects the
   * best version (not a destructive last rewrite).
   */
  reportOverride?: string,
): ResearchResult {
  let report = reportOverride?.trim() || extractFinalReport(messages) || "";

  // Fall back to partial report from notes if no assistant report text
  if (!report && notes.length > 0) {
    report = buildPartialReport(notes, topic);
  }

  // Collect all unique sources
  const uniqueUrls = new Set(notes.flatMap((n) => n.sourceUrls));

  const normalizedNotes = notes.map((n) => ({
    title: n.title,
    content: n.content,
    sourceUrls: n.sourceUrls,
    confidence: n.confidence ?? ("high" as const),
    ...(n.keyExcerpts?.length ? { keyExcerpts: n.keyExcerpts } : {}),
  }));
  const sources = Array.from(uniqueUrls).map((url) => ({
    title: urlTitles.get(url) ?? url,
    url,
  }));
  const explanation = buildExplanationModel({
    report,
    notes: normalizedNotes,
    mode,
    ...(verification ? { verification } : {}),
    urlTitles,
  });

  return {
    topic,
    report,
    notes: normalizedNotes,
    sources,
    messages,
    mode,
    explanation,
    ...(verification
      ? {
          verification: {
            attempts: verification.attempts,
            passRate: verification.result.summary.passRate,
            total: verification.result.summary.total,
            supported: verification.result.summary.supported,
            unsupported: verification.result.summary.unsupported,
            status: verification.result.summary.status,
            ...(verification.result.summary.reason ? { reason: verification.result.summary.reason } : {}),
            rewriteTriggered: verification.rewriteTriggered,
          },
        }
      : {}),
  };
}

/** Extract the most recent assistant text-only message (the final report). */
/**
 * Find the most recent report in the message log. Precedence:
 *   1. If a rewrite-steering user message was injected after the last submit_report,
 *      prefer assistant text that arrived after the steering — a rewrite is always
 *      delivered as plain text (the steering forbids further tool calls).
 *   2. Otherwise return the most recent submit_report tool-call payload.
 *   3. As a last resort, any trailing assistant text.
 *
 * The rewrite branch fixes a bug where the rewrite loop saw "no new report":
 * a successful rewrite arrives as text, but the OLD submit_report was still in
 * the history, masking the new text and making the diff check always equal.
 */
function extractFinalReport(messages: AgentMessage[]): string | null {
  const rewriteSteeringIndex = findLastRewriteSteeringIndex(messages);

  if (rewriteSteeringIndex >= 0) {
    for (let i = messages.length - 1; i > rewriteSteeringIndex; i--) {
      const text = textOnlyAssistantContent(messages[i]);
      if (text) return text;
    }
    // Steering was injected but the model didn't produce text — fall through.
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!("role" in msg) || msg.role !== "assistant") continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const content = msg.content[j];
      if (content.type !== "toolCall" || content.name !== "submit_report") continue;
      const args = content.arguments as { report?: unknown };
      if (typeof args.report === "string" && args.report.trim().length > 0) {
        return args.report.trim();
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textOnlyAssistantContent(messages[i]);
    if (text) return text;
  }
  return null;
}

/** Return assistant text only when the message has no tool calls (i.e. a final answer). */
function textOnlyAssistantContent(msg: AgentMessage): string | null {
  if (!("role" in msg) || msg.role !== "assistant") return null;
  if (msg.content.some((c) => c.type === "toolCall")) return null;
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** Find the index of the most recent rewrite-steering user message, or -1. */
function findLastRewriteSteeringIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!("role" in msg) || msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string" && content.startsWith(REWRITE_STEERING_PREFIX)) {
      return i;
    }
  }
  return -1;
}

const REWRITE_STEERING_PREFIX = "[SYSTEM] Citation verification:";

/** Count how many rewrite-steering messages have been injected into the log. */
function countRewriteAttempts(messages: AgentMessage[]): number {
  let n = 0;
  for (const msg of messages) {
    if (!("role" in msg) || msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string" && content.startsWith(REWRITE_STEERING_PREFIX)) {
      n++;
    }
  }
  return n;
}

/** Throw if the last agent message is an error (e.g. auth failure, rate limit). */
function checkForAgentError(messages: AgentMessage[]): void {
  const last = messages.at(-1);
  if (
    last &&
    "role" in last &&
    last.role === "assistant" &&
    "errorMessage" in last &&
    last.errorMessage
  ) {
    throw new Error(`Agent error: ${last.errorMessage}`);
  }
}

/** Create and configure the Absurd app with the research task. */
export function createResearchApp(options: ResearchAppOptions = {}): Absurd {
  const dbUrl = options.databaseUrl
    ?? process.env.DATABASE_URL
    ?? "postgresql://postgres:postgres@localhost:5432/absurd";
  const app = new Absurd({
    db: dbUrl,
    queueName: options.queueName,
  });

  // Store usage stats outside the task handler so the CLI can access them
  let lastUsage: UsageStats | undefined;
  const taskLog = (...args: Parameters<typeof console.log>) => {
    if (!options.quiet) console.log(...args);
  };

  app.registerTask<ResearchParams, ResearchResult>(
    {
      name: "research",
      defaultMaxAttempts: 3,
      defaultCancellation: { maxDuration: getMaxDurationSeconds() },
    },
    async (params, ctx) => {
      const bus = options.eventBus;
      bus?.emit({ type: "agent-status", text: "Initializing research task..." });

      const steelClient = createSteelClient();
      const depth = params.depth ?? "standard";
      const depthConfig = DEPTH_CONFIG[depth];

      // 0. Resolve task mode — caller can pin it via params.mode; otherwise classify
      // once (durably checkpointed so resume is free).
      if (!params.mode) {
        bus?.emit({ type: "agent-status", text: "Classifying task mode..." });
      }
      const mode: TaskMode = params.mode ?? await ctx.step("classify-mode", () =>
        classifyTask({ topic: params.topic }),
      );
      // Surface the resolved mode + budget up front so it's obvious in logs and TUI.
      const resolvedSourceCeiling = params.maxSources ?? depthConfig.maxSources;
      taskLog(`[MODE] ${mode} · depth ${depth} · sources ${resolvedSourceCeiling}`);
      bus?.emit({
        type: "agent-status",
        text: `Mode: ${mode} · depth ${depth} · ${resolvedSourceCeiling} sources`,
      });

      // 1. Replay checkpointed messages
      bus?.emit({ type: "agent-status", text: "Loading checkpoint..." });
      let { messages, nextHandle } = await loadMessageLog(ctx);

      // 2. Rebuild in-memory state from replayed messages
      const rebuilt = rebuildStateFromMessages(messages);
      const scrapedUrls = rebuilt.scrapedUrls;

      // Deduplicate notes on resume to clean up any duplicates from prior runs
      const notes = rebuilt.notes.length > 0
        ? deduplicateNotes(rebuilt.notes)
        : rebuilt.notes;

      // Seed with prior research if extending a completed run
      if (params.priorNotes?.length) {
        for (const note of params.priorNotes) notes.push(note);
      }
      if (params.priorUrls?.length) {
        for (const url of params.priorUrls) scrapedUrls.add(url);
      }

      // Snapshot rebuilt state to the TUI so a resumed run shows prior findings
      // even when the agent loop has nothing new to do (e.g. fully-completed
      // task being re-claimed only for finalization). Turn count = number of
      // assistant messages already in the log.
      const priorTurn = messages.filter(
        (m): m is Extract<typeof m, { role: "assistant" }> =>
          "role" in m && m.role === "assistant",
      ).length;
      bus?.emit({
        type: "snapshot",
        turn: priorTurn,
        sources: scrapedUrls.size,
        notes: notes.slice(),
      });

      // Log resume info only when we'll actually continue the loop (not on completed re-runs)
      const lastMsg = messages.at(-1);
      const isAlreadyComplete = lastMsg &&
        "role" in lastMsg &&
        lastMsg.role === "assistant" &&
        lastMsg.content.every((c: { type: string }) => c.type !== "toolCall") &&
        !("errorMessage" in lastMsg && lastMsg.errorMessage);

      if (messages.length > 0 && !isAlreadyComplete) {
        taskLog(
          `Resumed from checkpoint: ${messages.length} messages, ${notes.length} notes, ${scrapedUrls.size} URLs`,
        );
        bus?.emit({
          type: "agent-status",
          text: `Resumed: ${notes.length} notes, ${scrapedUrls.size} sources — continuing...`,
        });
      } else if (isAlreadyComplete) {
        bus?.emit({
          type: "agent-status",
          text: `Resumed completed task — verifying and finalizing...`,
        });
      } else {
        bus?.emit({ type: "agent-status", text: "Starting fresh research..." });
      }

      // 3. Create tools with closures over mutable state
      const resolvedMaxSources = params.maxSources ?? depthConfig.maxSources;
      const prefetchBudget = Math.floor(resolvedMaxSources / 2);
      // BENCH_CACHE_KEY (e.g. `draco:<task_id>`) overrides ctx.taskID so benchmark
      // re-runs share the browse cache across Absurd invocations.
      const taskId = resolveCacheKey(ctx.taskID);
      // Per-task store of verbatim excerpts keyed by URL — populated by browse_url and
      // consumed by claim verification as a fallback when notes don't list the cited URL.
      const urlExcerpts = createUrlExcerptStore();
      // On resume the in-memory store starts empty; rebuild from browse_cache so the
      // verifier has the same grounding it would have had during the original run.
      if (scrapedUrls.size > 0) {
        await rebuildUrlExcerptsFromCache(urlExcerpts, scrapedUrls, (url) =>
          getCachedBrowse(taskId, url).catch(() => null),
        );
      }
      // Route per-tool progress (plan/prefetch/scout) through the bus when the
      // TUI is active so those lines don't write straight to stdout and corrupt
      // ink's render. Falls back to plain console.log when no bus is wired.
      const toolProgress = bus ? createToolProgress(bus) : undefined;
      // Gap-fill loop is only worth its turns for breadth-oriented modes with a budget.
      const gapPasses = (mode === "survey" || mode === "synthesis") ? depthConfig.gapPasses : 0;
      // Reference chasing follows paper citation graphs; reserve it for breadth surveys.
      const referenceChasingEnabled = mode === "survey";
      // Seed the queue with scrapedUrls so already-visited pages are never re-queued.
      const referenceQueue = createReferenceQueue(scrapedUrls);
      const tools = [
        (() => {
          const submittedReport: SubmittedReportRef = { value: null };
          return createSubmitReportTool(submittedReport);
        })(),
        createPlanTool(params, mode, toolProgress),
        createPrefetchTool(steelClient, scrapedUrls, params.topic, prefetchBudget, taskId, toolProgress, urlExcerpts),
        createScoutTool(steelClient, scrapedUrls, params.topic, taskId, toolProgress, urlExcerpts, referenceQueue),
        createSearchTool(steelClient, scrapedUrls, params.topic),
        createBrowseTool(steelClient, scrapedUrls, params.topic, taskId, urlExcerpts, referenceQueue),
        createScreenshotTool(steelClient),
        createNoteTool(notes),
        createEvaluateTool(notes, scrapedUrls, mode),
        ...(gapPasses > 0
          ? [
              createGapAnalysisTool({ notes, topic: params.topic, maxCalls: gapPasses, progress: toolProgress }),
              createFindEntityTool(steelClient, scrapedUrls, params.topic, taskId, toolProgress, urlExcerpts),
            ]
          : []),
        ...(referenceChasingEnabled
          ? [createChaseReferencesTool(steelClient, scrapedUrls, params.topic, referenceQueue, taskId, toolProgress, urlExcerpts)]
          : []),
        createUseAdapterTool(),
        createWriteAdapterTool(),
      ];

      // 4. Build system prompt from template
      const systemPrompt = await loadTemplate("system", {
        topic: params.topic,
        depth,
        mode,
        maxSources: resolvedMaxSources,
        maxIterations: depthConfig.maxIterations,
      });

      // 5. Build agent context
      const context: AgentContext = {
        systemPrompt,
        tools,
        messages,
      };

      // Track limits for hard enforcement
      const maxBrowses = resolvedMaxSources;
      const maxTurns = depthConfig.maxIterations * 15;
      // Tool-call ceiling — a runaway-loop safety net that scales with the source
      // budget (a healthy run makes a few tool calls per source). Warn early; hard-stop
      // well above any legitimate run so we only catch genuine spirals.
      const toolCallHardCap = maxBrowses * 5 + 100;
      const toolCallWarnAt = Math.floor(toolCallHardCap * 0.6);

      // Timeout handling: detect approaching deadline and force report
      const taskStartTime = Date.now();
      // Depth-aware soft timeout: deep needs more time than quick.
      // Absurd's hard cancellation (set at registration with the longest depth)
      // is the backstop; this graceful wrap-up fires earlier for quick/standard.
      const maxDuration = getMaxDurationMs(depth);
      const TIMEOUT_BUFFER = 60_000;
      const timeoutCheck = createTimeoutSteeringCheck(taskStartTime, maxDuration, TIMEOUT_BUFFER);

      // Usage tracking
      const usage: UsageStats = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        models: {},
      };
      lastUsage = usage;

      const agentModel = getAgentModel(options.model);

      // Track whether we've already sent the "stop" steering message
      let steeringSent = false;
      // Track browses since last evaluate for auto-injection
      let browsesSinceEval = 0;
      const EVAL_INTERVAL = 5;
      // Total tool calls this run — guards against runaway loops (see toolCallHardCap).
      let toolCallCount = 0;
      let toolCallWarned = false;

      const config: AgentLoopConfig = {
        model: agentModel,
        convertToLlm,
        toolExecution: "parallel",
        reasoning: getAgentReasoning(),
        getApiKey: (provider) => getEnvApiKey(provider),
        afterToolCall: async (ctx) => {
          toolCallCount++;
          if (!toolCallWarned && toolCallCount >= toolCallWarnAt) {
            toolCallWarned = true;
            taskLog(`[BUDGET] ${toolCallCount} tool calls (warn at ${toolCallWarnAt}, hard cap ${toolCallHardCap}) — wrap up soon.`);
          }
          // Count browses and prefetches; reset on evaluate
          if (ctx.toolCall.name === "browse_url" || ctx.toolCall.name === "prefetch_sources") {
            browsesSinceEval++;
          } else if (ctx.toolCall.name === "evaluate_progress") {
            browsesSinceEval = 0;
          }
          return undefined;
        },
        getSteeringMessages: async () => {
          const userSteering = drainUserSteering(options.steeringQueue);
          if (userSteering.length > 0) return userSteering;

          // Only inject the stop message once
          if (steeringSent) return [];

          // Check timeout first — hardest constraint
          const timeout = timeoutCheck();
          if (timeout.shouldStop && timeout.message) {
            steeringSent = true;
            return [{
              role: "user" as const,
              content: timeout.message,
              timestamp: Date.now(),
            }];
          }

          const turnCount = context.messages.filter(
            (m) => "role" in m && m.role === "assistant",
          ).length;

          // Hard limits
          if (scrapedUrls.size >= maxBrowses || turnCount >= maxTurns || toolCallCount >= toolCallHardCap) {
            steeringSent = true;
            const reason = scrapedUrls.size >= maxBrowses
              ? `source limit (${maxBrowses})`
              : turnCount >= maxTurns
                ? `turn limit (${maxTurns})`
                : `tool-call limit (${toolCallHardCap})`;
            return [{
              role: "user" as const,
              content: `[SYSTEM] You have reached the maximum ${reason}. Stop browsing and searching. Write your final research report NOW using the notes you have collected. Use numeric inline citations like [1] and a numbered Sources section; do not use markdown author links as citations. Do NOT call any tools. Just write the report.`,
              timestamp: Date.now(),
            }];
          }

          // Auto-inject evaluation data after N browses without an explicit evaluate call
          if (browsesSinceEval >= EVAL_INTERVAL) {
            browsesSinceEval = 0;

            const highCount = notes.filter((n) => n.confidence === "high").length;
            const medCount = notes.filter((n) => n.confidence === "medium").length;
            const lowCount = notes.filter((n) => n.confidence === "low").length;
            const domains = new Set(
              notes
                .flatMap((n) => n.sourceUrls)
                .map((u) => { try { return new URL(u).hostname; } catch { return u; } }),
            );

            return [{
              role: "user" as const,
              content: [
                `[SYSTEM] Auto-evaluation after ${EVAL_INTERVAL} browses:`,
                `Sources: ${scrapedUrls.size}/${maxBrowses} | Notes: ${notes.length} (${highCount} high, ${medCount} med, ${lowCount} low) | Domains: ${domains.size}`,
                `Turns: ${turnCount}/${maxTurns}`,
                ``,
                `Review your coverage. If you have enough high-confidence notes across diverse sources, write your final report. Otherwise, identify specific gaps and do targeted searches.`,
                `When you write the final report, use numeric inline citations like [1] and a numbered Sources section. Do not use markdown author links as citations.`,
              ].join("\n"),
              timestamp: Date.now(),
            }];
          }

          return [];
        },
      };

      // 6. Set up durable message persistence with logging
      const persisterOpts = {
        maxSources: maxBrowses,
        maxTurns,
        scrapedUrls,
        usage,
        eventBus: options.eventBus,
        quiet: options.quiet,
      };
      // Helper: count completed assistant turns so subsequent persisters resume the
      // turn counter instead of restarting at 0 (which made resume + rewrite turns
      // appear as "turn 1" in the TUI).
      const countCompletedTurns = (): number =>
        context.messages.filter((m) => "role" in m && m.role === "assistant").length;
      const persistEvent = createLoggingPersister(ctx, nextHandle, {
        ...persisterOpts,
        initialTurnCount: countCompletedTurns(),
      });

      // Helper: run agent loop with a hard timeout safety net
      async function runWithTimeout(
        persister: (event: import("@mariozechner/pi-agent-core").AgentEvent) => Promise<void>,
      ): Promise<void> {
        const elapsed = Date.now() - taskStartTime;
        const remainingMs = maxDuration - elapsed - 10_000; // 10s safety margin

        if (remainingMs <= 0) {
          taskLog("[TIMEOUT] No time remaining — building partial result.");
          return;
        }

        const abortController = new AbortController();
        let timerId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timerId = setTimeout(() => resolve("timeout"), remainingMs);
        });

        try {
          const result = await Promise.race([
            runAgentLoopContinue(context, config, persister, abortController.signal).then(() => "done" as const),
            timeoutPromise,
          ]);

          if (result === "timeout") {
            // Abort the agent loop so it stops producing output
            abortController.abort();
            taskLog("[TIMEOUT] Hard deadline approaching — building partial result from accumulated notes.");
          }
        } finally {
          clearTimeout(timerId!);
        }
      }

      // Track verification state across the run (re-derived from message log on resume).
      let verificationState: { result: VerificationResult; attempts: number; rewriteTriggered: boolean } | undefined;
      // Set by the rewrite loop's regression guard when a destructive rewrite would
      // otherwise leave us with a worse final report than an earlier attempt.
      let bestReportOverride: string | undefined;

      // 7. Handle first run vs resume
      const last = context.messages.at(-1);
      if (!last) {
        // Build user message — include prior findings if extending
        let userContent = `Research this topic thoroughly: ${params.topic}`;
        if (params.priorNotes?.length) {
          const notesSummary = params.priorNotes
            .map((n) => `- [${n.confidence}] ${n.title}: ${n.content.slice(0, 150)}`)
            .join("\n");
          userContent = [
            `Continue and extend prior research on: ${params.topic}`,
            ``,
            `Here are findings from the previous research session (${params.priorNotes.length} notes, ${params.priorUrls?.length ?? 0} sources already visited):`,
            notesSummary,
            ``,
            params.extensionInstruction
              ? `User instruction for this extension: ${params.extensionInstruction}`
              : `User instruction for this extension: gather more sources and strengthen weak or under-covered parts of the prior report.`,
            ``,
            `Focus on: gaps in the existing research, newer developments, alternative perspectives, and areas marked as low confidence. Do NOT re-browse URLs you have already visited.`,
          ].join("\n");
        }
        if (params.clarifications) {
          userContent += `\n\nThe user provided these clarifications to narrow the research scope:\n${params.clarifications}`;
        }
        const userMessage: AgentMessage = {
          role: "user" as const,
          content: userContent,
          timestamp: Date.now(),
        };
        await ctx.completeStep(nextHandle, {
          message: userMessage,
        } satisfies MessageLogEntry);
        context.messages.push(userMessage);
        nextHandle = await ctx.beginStep<MessageLogEntry>("message");

        const updatedPersister = createLoggingPersister(ctx, nextHandle, {
          ...persisterOpts,
          initialTurnCount: countCompletedTurns(),
        });
        await runWithTimeout(updatedPersister);
        checkForAgentError(context.messages);
      } else if (
        "role" in last &&
        last.role === "assistant" &&
        last.content.every((c) => c.type !== "toolCall") &&
        !("errorMessage" in last && last.errorMessage)
      ) {
        // Already-completed report on resume — fall through to verification below.
      } else if (
        "role" in last &&
        last.role === "assistant" &&
        "errorMessage" in last &&
        last.errorMessage
      ) {
        throw new Error(`Agent loop failed: ${last.errorMessage}`);
      } else {
        // Pop trailing assistant messages so runAgentLoopContinue can proceed
        // (it requires the last message to not be an assistant message)
        while (context.messages.length > 0) {
          const tail = context.messages.at(-1);
          if (tail && "role" in tail && tail.role === "assistant") {
            context.messages.pop();
          } else {
            break;
          }
        }
        if (context.messages.length === 0) {
          throw new Error("Resume failed: no non-assistant messages to continue from");
        }
        await runWithTimeout(persistEvent);
        checkForAgentError(context.messages);
      }

      // 8. Claim verification + bounded rewrite loop.
      //
      // Each iteration extracts the most recent assistant-text report, runs the
      // verifier as its own durable step (`verify-claims-attempt-N`), and — if the
      // pass rate is below threshold — injects a rewrite-steering message and re-runs
      // the agent loop. Stops on first verification that clears the threshold, when
      // the rewrite cap is hit, or when no fresh report is produced.
      //
      // The cap is 2 rewrites (so worst case: 3 verifies + 2 rewrite turns). Picked
      // because each rewrite is a full agent turn and we don't want runaway loops; a
      // model that can't reach 70% after two corrective passes likely needs different
      // sources rather than more attempts.
      const priorAttempts = countRewriteAttempts(context.messages);
      const finalReport = extractFinalReport(context.messages);
      const notesHaveExcerpts = notes.some((n) => n.keyExcerpts && n.keyExcerpts.length > 0);
      const MAX_REWRITES = 2;

      // On a cold resume of an already-complete task (no fresh agent turn ran in this
      // process), don't initiate new rewrites — only load cached verification state.
      // This avoids burning verifier tokens on every resume, and prevents triggering
      // brand-new rewrites against reports that were already accepted previously.
      const lastForVerify = context.messages.at(-1);
      const resumedAlreadyComplete =
        !!lastForVerify &&
        "role" in lastForVerify &&
        lastForVerify.role === "assistant" &&
        lastForVerify.content.every((c) => c.type !== "toolCall") &&
        priorAttempts > 0;

      if (notesHaveExcerpts && finalReport) {
        const urlExcerptMap = urlExcerpts.asMap();

        if (resumedAlreadyComplete) {
          // Rebuild state from the most recently committed verify step. ctx.step is a
          // free cache lookup when committed; the try/catch only matters if the
          // verifier function itself throws (rare — verifyClaims swallows per-claim
          // errors). On a cold resume where attempt-(priorAttempts+1) was never run,
          // this transparently runs a fresh verification, which is the right call:
          // the rewrite produced a new report and we still need to verify it.
          for (let attemptN = priorAttempts + 1; attemptN >= 1; attemptN--) {
            try {
              const cached = await ctx.step(`verify-claims-attempt-${attemptN}`, () =>
                verifyClaims({ report: finalReport, notes, urlExcerpts: urlExcerptMap }),
              );
              verificationState = {
                result: cached,
                attempts: attemptN,
                // Reflect whether THIS attempt would still trigger a rewrite, not
                // whether earlier rewrites happened — that's what downstream code
                // means by "rewriteTriggered".
                rewriteTriggered: shouldTriggerRewrite(cached),
              };
              break;
            } catch {
              // Verifier throw on this attempt — fall back to the previous index.
            }
          }
        } else {
          let rewritesSoFar = priorAttempts;
          let currentReport = finalReport;
          // Track the best (report, result) seen across all attempts so a destructive
          // rewrite cannot leave us with a worse final report than we started with.
          let bestReport: string | null = null;
          let bestResult: VerificationResult | null = null;

          while (currentReport) {
            const attemptN = rewritesSoFar + 1;
            if (attemptN === 1) {
              taskLog("[VERIFY] Checking citations against source excerpts...");
            } else {
              taskLog(`[VERIFY] Re-checking citations after rewrite ${attemptN - 1}...`);
            }
            bus?.emit({ type: "phase", phase: "verifying" });
            bus?.emit({ type: "agent-status", text: `Verifying citations (attempt ${attemptN})...` });

            const result: VerificationResult = await ctx.step(`verify-claims-attempt-${attemptN}`, () =>
              verifyClaims({ report: currentReport!, notes, urlExcerpts: urlExcerptMap }),
            );
            // Update the best-so-far before deciding on rewrite. The first
            // iteration always wins by default; later iterations only replace
            // it if they're genuinely better.
            if (!bestResult || isBetterVerification(result, bestResult)) {
              bestReport = currentReport;
              bestResult = result;
            }
            const triggered = shouldTriggerRewrite(result);
            taskLog(
              `[VERIFY] ${result.summary.supported}/${result.summary.total} claims supported (${Math.round(result.summary.passRate * 100)}%).${result.summary.reason ? ` ${result.summary.reason}.` : ""}${triggered ? ` Rewriting (${rewritesSoFar + 1}/${MAX_REWRITES}).` : ""}`,
            );
            bus?.emit({
              type: "verification-result",
              attempt: attemptN,
              passRate: result.summary.passRate,
              supported: result.summary.supported,
              total: result.summary.total,
              threshold: VERIFY_PASS_THRESHOLD,
              willRewrite: triggered && rewritesSoFar < MAX_REWRITES,
              status: result.summary.status,
              reason: result.summary.reason,
            });
            bus?.emit({
              type: "agent-status",
              text: `Citations attempt ${attemptN}: ${result.summary.supported}/${result.summary.total} (${Math.round(result.summary.passRate * 100)}%)${triggered ? " — rewriting" : " — passed"}`,
            });

            verificationState = {
              result,
              attempts: attemptN,
              // Reflect the LATEST attempt's verdict — final-pass after rewrites
              // should report false, not true-because-an-earlier-attempt-triggered.
              rewriteTriggered: triggered,
            };

            if (!triggered) break;
            if (rewritesSoFar >= MAX_REWRITES) {
              taskLog(`[VERIFY] Hit rewrite cap (${MAX_REWRITES}); accepting current report.`);
              break;
            }

            bus?.emit({ type: "phase", phase: "rewriting" });
            const steeringMessage: AgentMessage = {
              role: "user" as const,
              content: buildRewriteSteering(result),
              timestamp: Date.now(),
            };
            await ctx.completeStep(nextHandle, { message: steeringMessage } satisfies MessageLogEntry);
            context.messages.push(steeringMessage);
            nextHandle = await ctx.beginStep<MessageLogEntry>("message");
            // Continue the turn counter from the prior research turns so the TUI shows
            // the rewrite as turn N+1, not as a fresh "turn 1".
            const rewritePersister = createLoggingPersister(ctx, nextHandle, {
              ...persisterOpts,
              initialTurnCount: countCompletedTurns(),
            });
            await runWithTimeout(rewritePersister);
            checkForAgentError(context.messages);

            rewritesSoFar++;
            const nextReport = extractFinalReport(context.messages);
            if (!nextReport || nextReport === currentReport) {
              taskLog("[VERIFY] Rewrite produced no new report; stopping.");
              break;
            }
            currentReport = nextReport;
          }

          // Regression guard: if the loop's latest attempt is worse than the best
          // we saw earlier, restore the best. Common pattern: original at 30%,
          // rewrite strips to no_claims, the original wins.
          if (
            bestResult &&
            bestReport &&
            verificationState &&
            isBetterVerification(bestResult, verificationState.result)
          ) {
            taskLog(
              `[VERIFY] Restoring best earlier report (${bestResult.summary.supported}/${bestResult.summary.total} supported) — last rewrite regressed.`,
            );
            bestReportOverride = bestReport;
            verificationState = {
              result: bestResult,
              attempts: verificationState.attempts,
              rewriteTriggered: shouldTriggerRewrite(bestResult),
            };
          }
        }
      }

      bus?.emit({ type: "phase", phase: "complete" });

      // Fetch real page titles for cited sources. Falls back to URL on miss, so the
      // final report stops rendering ugly URLs as titles.
      const allCitedUrls = Array.from(new Set(notes.flatMap((n) => n.sourceUrls)));
      const urlTitles = await getTitlesForUrls(taskId, allCitedUrls).catch(
        () => new Map<string, string>(),
      );

      return buildResult(notes, params.topic, messages, verificationState, mode, urlTitles, bestReportOverride);
    },
  );

  // Expose usage stats getter
  (app as any).getLastUsage = () => lastUsage;

  return app;
}
