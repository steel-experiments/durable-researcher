// ABOUTME: Absurd task registration and durable agent loop orchestration.
// ABOUTME: Registers a "research" task that runs a Pi Agent loop with checkpointed turns.

import { Absurd } from "absurd-sdk";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
} from "@mariozechner/pi-agent-core";
import { getEnvApiKey, type Message, type Model, type Api } from "@mariozechner/pi-ai";
import {
  getAgentModel,
  getAgentReasoning,
  getMaxDurationMs,
  getMaxDurationSeconds,
} from "./config.js";
import type { ResearchParams, ResearchResult, MessageLogEntry } from "./types.js";
import { DEPTH_CONFIG } from "./types.js";
import { createSteelClient } from "./steel-client.js";
import { createSearchTool } from "./tools/search.js";
import { createBrowseTool } from "./tools/browse.js";
import { createScreenshotTool } from "./tools/screenshot.js";
import { createNoteTool } from "./tools/note.js";
import { createEvaluateTool } from "./tools/evaluate.js";
import { createPlanTool } from "./tools/plan.js";
import { createPrefetchTool } from "./tools/prefetch.js";
import { createScoutTool } from "./tools/scout.js";
import {
  loadMessageLog,
  createLoggingPersister,
  rebuildStateFromMessages,
  type UsageStats,
} from "./durable-turns.js";
import { deduplicateNotes } from "./notes-ranker.js";
import { loadTemplate } from "./prompts.js";

/** Options for creating the research app. */
export type ResearchAppOptions = {
  databaseUrl?: string;
  model?: Model<Api>;
  queueName?: string;
};

/**
 * Convert AgentMessages to LLM-compatible Messages.
 * Standard messages pass through; anything without a recognized role is filtered.
 */
function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      "role" in m &&
      (m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
  );
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
      message: `[SYSTEM] Approaching task timeout (${Math.round(elapsed / 1000)}s elapsed of ${Math.round(maxDuration / 1000)}s max). Stop ALL tool use immediately and write your final research report NOW using the notes you have collected.`,
    };
  };
}

/** Build the final research result from accumulated notes and messages. */
export function buildResult(
  notes: { title: string; content: string; sourceUrls: string[]; confidence?: "high" | "medium" | "low"; keyExcerpts?: string[] }[],
  topic: string,
  messages: AgentMessage[],
): ResearchResult {
  // Extract the final assistant message as the report
  let report = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ("role" in msg && msg.role === "assistant") {
      const textParts = msg.content.filter(
        (c): c is { type: "text"; text: string } => c.type === "text",
      );
      const text = textParts.map((c) => c.text).join("\n");
      if (text.length > 0) {
        report = text;
        break;
      }
    }
  }

  // Fall back to partial report from notes if no assistant report text
  if (!report && notes.length > 0) {
    report = buildPartialReport(notes, topic);
  }

  // Collect all unique sources
  const uniqueUrls = new Set(notes.flatMap((n) => n.sourceUrls));

  return {
    topic,
    report,
    notes: notes.map((n) => ({
      title: n.title,
      content: n.content,
      sourceUrls: n.sourceUrls,
      confidence: n.confidence ?? ("high" as const),
      ...(n.keyExcerpts?.length ? { keyExcerpts: n.keyExcerpts } : {}),
    })),
    sources: Array.from(uniqueUrls).map((url) => ({ title: url, url })),
    messages,
  };
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

  app.registerTask<ResearchParams, ResearchResult>(
    {
      name: "research",
      defaultMaxAttempts: 3,
      defaultCancellation: { maxDuration: getMaxDurationSeconds() },
    },
    async (params, ctx) => {
      const steelClient = createSteelClient();
      const depth = params.depth ?? "standard";
      const depthConfig = DEPTH_CONFIG[depth];

      // 1. Replay checkpointed messages
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

      // Log resume info only when we'll actually continue the loop (not on completed re-runs)
      const lastMsg = messages.at(-1);
      const isAlreadyComplete = lastMsg &&
        "role" in lastMsg &&
        lastMsg.role === "assistant" &&
        lastMsg.content.every((c: { type: string }) => c.type !== "toolCall") &&
        !("errorMessage" in lastMsg && lastMsg.errorMessage);

      if (messages.length > 0 && !isAlreadyComplete) {
        console.log(
          `Resumed from checkpoint: ${messages.length} messages, ${notes.length} notes, ${scrapedUrls.size} URLs`,
        );
      }

      // 3. Create tools with closures over mutable state
      const prefetchBudget = Math.floor((params.maxSources ?? 20) / 2);
      const taskId = ctx.taskID;
      const tools = [
        createPlanTool(params),
        createPrefetchTool(steelClient, scrapedUrls, params.topic, prefetchBudget, taskId),
        createScoutTool(steelClient, scrapedUrls, params.topic, taskId),
        createSearchTool(steelClient, scrapedUrls, params.topic),
        createBrowseTool(steelClient, scrapedUrls, params.topic, taskId),
        createScreenshotTool(steelClient),
        createNoteTool(notes),
        createEvaluateTool(notes, scrapedUrls),
      ];

      // 4. Build system prompt from template
      const systemPrompt = await loadTemplate("system", {
        topic: params.topic,
        depth,
        maxSources: params.maxSources ?? 20,
        maxIterations: depthConfig.maxIterations,
      });

      // 5. Build agent context
      const context: AgentContext = {
        systemPrompt,
        tools,
        messages,
      };

      // Track limits for hard enforcement
      const maxBrowses = params.maxSources ?? 20;
      const maxTurns = depthConfig.maxIterations * 15;

      // Timeout handling: detect approaching deadline and force report
      const taskStartTime = Date.now();
      const maxDuration = getMaxDurationMs();
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

      const config: AgentLoopConfig = {
        model: agentModel,
        convertToLlm,
        toolExecution: "parallel",
        reasoning: getAgentReasoning(),
        getApiKey: (provider) => getEnvApiKey(provider),
        afterToolCall: async (ctx) => {
          // Count browses and prefetches; reset on evaluate
          if (ctx.toolCall.name === "browse_url" || ctx.toolCall.name === "prefetch_sources") {
            browsesSinceEval++;
          } else if (ctx.toolCall.name === "evaluate_progress") {
            browsesSinceEval = 0;
          }
          return undefined;
        },
        getSteeringMessages: async () => {
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
          if (scrapedUrls.size >= maxBrowses || turnCount >= maxTurns) {
            steeringSent = true;
            const reason = scrapedUrls.size >= maxBrowses
              ? `source limit (${maxBrowses})`
              : `turn limit (${maxTurns})`;
            return [{
              role: "user" as const,
              content: `[SYSTEM] You have reached the maximum ${reason}. Stop browsing and searching. Write your final research report NOW using the notes you have collected. Do NOT call any tools. Just write the report.`,
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
              ].join("\n"),
              timestamp: Date.now(),
            }];
          }

          return [];
        },
      };

      // 6. Set up durable message persistence with logging
      const persisterOpts = { maxSources: maxBrowses, maxTurns, scrapedUrls, usage };
      const persistEvent = createLoggingPersister(ctx, nextHandle, persisterOpts);

      // Helper: run agent loop with a hard timeout safety net
      async function runWithTimeout(
        persister: (event: import("@mariozechner/pi-agent-core").AgentEvent) => Promise<void>,
      ): Promise<void> {
        const elapsed = Date.now() - taskStartTime;
        const remainingMs = maxDuration - elapsed - 10_000; // 10s safety margin

        if (remainingMs <= 0) {
          console.log("[TIMEOUT] No time remaining — building partial result.");
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
            console.log("[TIMEOUT] Hard deadline approaching — building partial result from accumulated notes.");
          }
        } finally {
          clearTimeout(timerId!);
        }
      }

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

        const updatedPersister = createLoggingPersister(ctx, nextHandle, persisterOpts);
        await runWithTimeout(updatedPersister);
        checkForAgentError(context.messages);
      } else if (
        "role" in last &&
        last.role === "assistant" &&
        last.content.every((c) => c.type !== "toolCall") &&
        !("errorMessage" in last && last.errorMessage)
      ) {
        return buildResult(notes, params.topic, messages);
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

      return buildResult(notes, params.topic, messages);
    },
  );

  // Expose usage stats getter
  (app as any).getLastUsage = () => lastUsage;

  return app;
}
