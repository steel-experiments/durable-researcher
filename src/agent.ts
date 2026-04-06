// ABOUTME: Absurd task registration and durable agent loop orchestration.
// ABOUTME: Registers a "research" task that runs a Pi Agent loop with checkpointed turns.

import { Absurd } from "absurd-sdk";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
} from "@mariozechner/pi-agent-core";
import { getModel, getEnvApiKey, type Message, type Model, type Api } from "@mariozechner/pi-ai";
import type { ResearchParams, ResearchResult, MessageLogEntry } from "./types.js";
import { DEPTH_CONFIG } from "./types.js";
import { createSteelClient } from "./steel-client.js";
import { createSearchTool } from "./tools/search.js";
import { createBrowseTool } from "./tools/browse.js";
import { createScreenshotTool } from "./tools/screenshot.js";
import { createNoteTool } from "./tools/note.js";
import { createEvaluateTool } from "./tools/evaluate.js";
import { createPlanTool } from "./tools/plan.js";
import {
  loadMessageLog,
  createLoggingPersister,
  rebuildStateFromMessages,
  type UsageStats,
} from "./durable-turns.js";
import { loadTemplate } from "./prompts.js";

/** Options for creating the research app. */
export type ResearchAppOptions = {
  databaseUrl?: string;
  model?: Model<Api>;
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

/** Build the final research result from accumulated notes and messages. */
function buildResult(
  notes: { title: string; content: string; sourceUrls: string[] }[],
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
      report = textParts.map((c) => c.text).join("\n");
      break;
    }
  }

  // Collect all unique sources
  const allUrls = notes.flatMap((n) => n.sourceUrls);
  const sourceMap = new Map<string, string>();
  for (const url of allUrls) {
    if (!sourceMap.has(url)) {
      sourceMap.set(url, url);
    }
  }

  return {
    topic,
    report,
    notes: notes.map((n) => ({
      title: n.title,
      content: n.content,
      sourceUrls: n.sourceUrls,
      confidence: "high" as const,
    })),
    sources: Array.from(sourceMap.entries()).map(([url]) => ({
      title: url,
      url,
    })),
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
  const app = new Absurd(dbUrl);

  // Store usage stats outside the task handler so the CLI can access them
  let lastUsage: UsageStats | undefined;

  app.registerTask<ResearchParams, ResearchResult>(
    {
      name: "research",
      defaultMaxAttempts: 3,
      defaultCancellation: { maxDuration: 600_000 },
    },
    async (params, ctx) => {
      const steelClient = createSteelClient();
      const depth = params.depth ?? "standard";
      const depthConfig = DEPTH_CONFIG[depth];

      // 1. Replay checkpointed messages
      let { messages, nextHandle } = await loadMessageLog(ctx);

      // 2. Rebuild in-memory state from replayed messages
      const { notes, scrapedUrls } = rebuildStateFromMessages(messages);

      if (messages.length > 0) {
        console.log(
          `Resumed from checkpoint: ${messages.length} messages, ${notes.length} notes, ${scrapedUrls.size} URLs`,
        );
      }

      // 3. Create tools with closures over mutable state
      const tools = [
        createPlanTool(params),
        createSearchTool(steelClient, scrapedUrls),
        createBrowseTool(steelClient, scrapedUrls, params.topic),
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

      // Usage tracking
      const usage: UsageStats = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        models: {},
      };
      lastUsage = usage;

      const agentModel = options.model ?? getModel("zai", "glm-5.1");

      const config: AgentLoopConfig = {
        model: agentModel,
        convertToLlm,
        toolExecution: "parallel",
        getApiKey: (provider) => getEnvApiKey(provider),
        getSteeringMessages: async () => {
          const turnCount = context.messages.filter(
            (m) => "role" in m && m.role === "assistant",
          ).length;

          if (scrapedUrls.size >= maxBrowses) {
            return [{
              role: "user" as const,
              content: `[SYSTEM] You have reached the maximum source limit (${maxBrowses}). Stop browsing and searching. Write your final research report NOW using the notes you have collected.`,
              timestamp: Date.now(),
            }];
          }

          if (turnCount >= maxTurns) {
            return [{
              role: "user" as const,
              content: `[SYSTEM] You have reached the maximum turn limit (${maxTurns}). Stop researching. Write your final research report NOW using the notes you have collected.`,
              timestamp: Date.now(),
            }];
          }

          return [];
        },
      };

      // 6. Set up durable message persistence with logging
      const persisterOpts = { maxSources: maxBrowses, maxTurns, scrapedUrls, usage };
      const persistEvent = createLoggingPersister(ctx, nextHandle, persisterOpts);

      // 7. Handle first run vs resume
      const last = context.messages.at(-1);
      if (!last) {
        const userMessage: AgentMessage = {
          role: "user" as const,
          content: `Research this topic thoroughly: ${params.topic}`,
          timestamp: Date.now(),
        };
        await ctx.completeStep(nextHandle, {
          message: userMessage,
        } satisfies MessageLogEntry);
        context.messages.push(userMessage);
        nextHandle = await ctx.beginStep<MessageLogEntry>("message");

        const updatedPersister = createLoggingPersister(ctx, nextHandle, persisterOpts);
        await runAgentLoopContinue(context, config, updatedPersister);
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
        const lastMsg = context.messages.at(-1);
        if (lastMsg && "role" in lastMsg && lastMsg.role === "assistant") {
          context.messages.pop();
        }
        await runAgentLoopContinue(context, config, persistEvent);
        checkForAgentError(context.messages);
      }

      return buildResult(notes, params.topic, messages);
    },
  );

  // Expose usage stats getter
  (app as any).getLastUsage = () => lastUsage;

  return app;
}
