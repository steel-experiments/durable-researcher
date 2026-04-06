// ABOUTME: browse_url tool — scrapes a URL via Steel and LLM-summarizes the content.
// ABOUTME: Returns a RefinedContent summary instead of raw page content to save context window.

import Steel from "steel-sdk";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { completeSimple, getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import { scrapeUrl } from "../steel-client.js";
import { isContentMeaningful, truncateContent } from "../content.js";
import { loadTemplate } from "../prompts.js";
import type { RefinedContent } from "../types.js";

const BrowseParams = Type.Object({
  url: Type.String({ description: "The URL to browse and extract content from" }),
  focus: Type.Optional(
    Type.String({
      description:
        "What to focus on when summarizing (e.g. 'error correction techniques', 'benchmark results')",
    }),
  ),
});

const SUMMARY_MAX_TOKENS = 500;

/** Create a browse_url tool that scrapes and summarizes page content. */
export function createBrowseTool(
  client: Steel,
  scrapedUrls: Set<string>,
  researchTopic: string,
): AgentTool<typeof BrowseParams> {
  return {
    name: "browse_url",
    label: "Browse URL",
    description:
      "Navigate to a URL, scrape its content, and return a focused summary. Use the 'focus' parameter to guide what information to extract.",
    parameters: BrowseParams,
    execute: async (_toolCallId, params) => {
      const { content, title, rawLength } = await scrapeUrl(client, params.url);
      scrapedUrls.add(params.url);

      if (!isContentMeaningful(content)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Page "${title}" (${params.url}) had insufficient content (${rawLength} chars raw). The page may require authentication, be paywalled, or contain mostly non-text content.`,
            },
          ],
          details: { url: params.url, title, rawLength, meaningful: false },
        };
      }

      // LLM-summarize the content
      let summary: string;
      try {
        summary = await summarizeContent(
          content,
          researchTopic,
          params.focus,
        );
      } catch {
        // Fallback: use first ~2000 chars of cleaned content
        summary = truncateContent(content, 2000);
      }

      const refined: RefinedContent = {
        title,
        url: params.url,
        summary,
        rawLength,
        scrapedAt: Date.now(),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `## ${refined.title}\n**Source:** ${refined.url}\n**Raw length:** ${refined.rawLength} chars\n\n${refined.summary}`,
          },
        ],
        details: refined,
      };
    },
  };
}

/** Timeout in ms for summarization LLM calls. */
const SUMMARIZE_TIMEOUT = 45_000;

/** Use a cheap LLM to summarize scraped content. */
export async function summarizeContent(
  content: string,
  topic: string,
  focus?: string,
): Promise<string> {
  const model = getModel("zai", "glm-4.7-flashx");
  const systemPrompt = await loadTemplate("summarize", { topic, focus });

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT);

  try {
    const message = await completeSimple(model, {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: content,
          timestamp: Date.now(),
        },
      ],
    }, {
      maxTokens: SUMMARY_MAX_TOKENS * 2,
      apiKey: getEnvApiKey("zai"),
      signal: controller.signal,
    });

    // Extract text from the assistant message
    const textContent = message.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    return textContent.map((c) => c.text).join("\n");
  } finally {
    clearTimeout(timerId);
  }
}
