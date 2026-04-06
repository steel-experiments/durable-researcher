// ABOUTME: Absurd task registration and durable agent loop orchestration.
// ABOUTME: Registers a "research" task that runs a Pi Agent loop with checkpointed turns.

import { Absurd } from "absurd-sdk";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
} from "@mariozechner/pi-agent-core";
import { getModel, getEnvApiKey, type Message } from "@mariozechner/pi-ai";
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
} from "./durable-turns.js";
import { loadTemplate } from "./prompts.js";

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
export function createResearchApp(databaseUrl?: string): Absurd {
  const url = databaseUrl
    ?? process.env.DATABASE_URL
    ?? "postgresql://postgres:postgres@localhost:5432/absurd";
  const app = new Absurd(url);

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

      const config: AgentLoopConfig = {
        model: getModel("zai", "glm-5.1"),
        convertToLlm,
        toolExecution: "sequential",
        getApiKey: (provider) => getEnvApiKey(provider),
      };

      // 6. Set up durable message persistence
      const persistEvent = createLoggingPersister(ctx, nextHandle);

      // 7. Handle first run vs resume
      const last = context.messages.at(-1);
      if (!last) {
        // First attempt: append user message and checkpoint it
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

        // Update the persister's handle reference by creating a new one
        const updatedPersister = createLoggingPersister(ctx, nextHandle);

        // 8. Run the durable agent loop
        await runAgentLoopContinue(context, config, updatedPersister);
        checkForAgentError(context.messages);
      } else if (
        "role" in last &&
        last.role === "assistant" &&
        last.content.every((c) => c.type !== "toolCall") &&
        !("errorMessage" in last && last.errorMessage)
      ) {
        // Already finished on a previous attempt (final assistant message with no tool calls and no error)
        return buildResult(notes, params.topic, messages);
      } else if (
        "role" in last &&
        last.role === "assistant" &&
        "errorMessage" in last &&
        last.errorMessage
      ) {
        // Last message was an error — throw so Absurd retries the task
        throw new Error(`Agent loop failed: ${last.errorMessage}`);
      } else {
        // Resume from checkpoint — strip trailing assistant message if present,
        // since runAgentLoopContinue requires last message to be user or toolResult.
        // This happens when the agent sent tool calls but crashed before tool results
        // were checkpointed. The agent will regenerate that turn.
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

  return app;
}
