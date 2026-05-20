// ABOUTME: Interactive follow-up questions after a research report is complete.
// ABOUTME: Runs a direct agent loop (no Absurd checkpointing) with the conversation history.

import * as readline from "node:readline";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentEvent,
} from "@mariozechner/pi-agent-core";
import { getEnvApiKey, type Model, type Api } from "@mariozechner/pi-ai";
import { getAgentModel, getAgentReasoning } from "./config.js";
import type { ResearchNote } from "./types.js";
import { createSteelClient } from "./steel-client.js";
import { createSearchTool } from "./tools/search.js";
import { createBrowseTool } from "./tools/browse.js";
import { createScoutTool } from "./tools/scout.js";
import { createScreenshotTool } from "./tools/screenshot.js";
import { createNoteTool } from "./tools/note.js";
import { createEvaluateTool } from "./tools/evaluate.js";
import { convertToLlm } from "./agent-messages.js";

/** Stream agent text to stdout, log tool calls. */
function createStreamingEmitter(): (event: AgentEvent) => void {
  let isStreaming = false;

  return (event: AgentEvent) => {
    if (event.type === "message_update") {
      const msg = event.message;
      if (
        "role" in msg &&
        msg.role === "assistant" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const hasToolCalls = msg.content.some(
          (c: { type: string }) => c.type === "toolCall",
        );
        if (!hasToolCalls) {
          if (!isStreaming) {
            isStreaming = true;
            console.log("");
          }
          process.stdout.write(event.assistantMessageEvent.delta);
        }
      }
    }

    if (event.type === "tool_execution_start") {
      console.log(`  [${event.toolName}] ${formatArgs(event.toolName, event.args)}`);
    }

    if (event.type === "message_end") {
      if (isStreaming) {
        console.log("\n");
        isStreaming = false;
      }
    }
  };
}

function formatArgs(name: string, args: Record<string, unknown>): string {
  if (name === "web_search") return `"${args.query}"`;
  if (name === "browse_url") return `"${args.url}"`;
  if (name === "take_note") return `"${args.title}"`;
  return "";
}

/** Run interactive follow-up loop after research completes. */
export async function runFollowUp(
  messages: AgentMessage[],
  topic: string,
  notes: ResearchNote[],
  scrapedUrls: Set<string>,
  model?: Model<Api>,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const steelClient = createSteelClient();
  const tools = [
    createScoutTool(steelClient, scrapedUrls, topic),
    createSearchTool(steelClient, scrapedUrls, topic),
    createBrowseTool(steelClient, scrapedUrls, topic),
    createScreenshotTool(steelClient),
    createNoteTool(notes),
    createEvaluateTool(notes, scrapedUrls),
  ];

  const agentModel = getAgentModel(model);

  const context: AgentContext = {
    systemPrompt: `You are a research assistant continuing a conversation about "${topic}". You have already produced a research report. The user is now asking follow-up questions. You have access to the same browsing and note-taking tools. Answer concisely, citing sources where applicable.`,
    tools,
    messages: [...messages],
  };

  const config: AgentLoopConfig = {
    model: agentModel,
    convertToLlm,
    toolExecution: "parallel",
    reasoning: getAgentReasoning(),
    getApiKey: (provider) => getEnvApiKey(provider),
  };

  console.log("\n" + "=".repeat(80));
  console.log("FOLLOW-UP MODE — ask questions about the research (type 'exit' to quit)");
  console.log("=".repeat(80) + "\n");

  const askQuestion = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("> ", (answer) => resolve(answer.trim()));
    });

  while (true) {
    const question = await askQuestion();
    if (!question || question.toLowerCase() === "exit") {
      console.log("Exiting follow-up mode.");
      break;
    }

    const userMessage: AgentMessage = {
      role: "user" as const,
      content: question,
      timestamp: Date.now(),
    };
    context.messages.push(userMessage);

    const emitter = createStreamingEmitter();
    try {
      await runAgentLoopContinue(context, config, emitter);
    } catch (err) {
      console.error("Error:", (err as Error).message);
    }
  }

  rl.close();
}
