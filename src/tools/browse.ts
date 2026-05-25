// ABOUTME: browse_url tool — scrapes a URL via Steel and LLM-summarizes the content.
// ABOUTME: Returns a RefinedContent summary instead of raw page content to save context window.

import Steel from "steel-sdk";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "../config.js";
import { scrapeUrl } from "../steel-client.js";
import { isContentMeaningful, truncateContent } from "../content.js";
import { loadTemplate } from "../prompts.js";
import { getCachedBrowse, setCachedBrowse } from "../browse-cache.js";
import { isPdfUrl, fetchAndExtractPdf } from "../pdf.js";
import type { RefinedContent } from "../types.js";
import { captureExcerptsForUrl, type UrlExcerptStore } from "../url-excerpts.js";

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

/** Content shorter than this is returned raw — preserves specific data. */
const SMART_SUMMARIZE_THRESHOLD = 4000;

export type BrowseContent = {
  content: string;
  title: string;
  rawLength: number;
};

/** Fetch content for a URL, using the PDF parser when the URL is clearly a PDF. */
export async function fetchBrowseContent(
  client: Steel,
  url: string,
): Promise<BrowseContent> {
  if (isPdfUrl(url)) {
    // PDFs return junk markdown from a normal scrape — fetch the bytes and
    // run a real PDF parser instead. Falls through to Steel scrape on failure.
    const pdf = await fetchAndExtractPdf(url);
    if (pdf && pdf.text.length > 0) {
      return {
        content: pdf.text,
        rawLength: pdf.byteLength,
        title: url.split("/").pop() ?? url,
      };
    }
  }

  return scrapeUrl(client, url);
}

/** Create a browse_url tool that scrapes and summarizes page content. */
export function createBrowseTool(
  client: Steel,
  scrapedUrls: Set<string>,
  researchTopic: string,
  taskId?: string,
  urlExcerpts?: UrlExcerptStore,
): AgentTool<typeof BrowseParams> {
  return {
    name: "browse_url",
    label: "Browse URL",
    description:
      "Navigate to a URL, scrape its content, and return a focused summary. Use the 'focus' parameter to guide what information to extract.",
    parameters: BrowseParams,
    execute: async (_toolCallId, params) => {
      // Check browse cache first
      let content: string;
      let title: string;
      let rawLength: number;

      const cached = taskId ? await getCachedBrowse(taskId, params.url).catch(() => null) : null;
      if (cached) {
        content = cached.content;
        title = cached.title;
        rawLength = cached.rawLength;
      } else {
        const scraped = await fetchBrowseContent(client, params.url);
        content = scraped.content;
        title = scraped.title;
        rawLength = scraped.rawLength;
      }
      scrapedUrls.add(params.url);

      const meaningful = isContentMeaningful(content);

      // Only cache meaningful content. Caching dead pages (bot blocks, paywalls,
      // empty responses) just makes resume blind to retries and pollutes the table.
      if (!cached && taskId && meaningful) {
        await setCachedBrowse(taskId, params.url, { title, content, rawLength }).catch(() => {});
      }

      if (!meaningful) {
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

      // Smart summarization: only LLM-summarize long content.
      // Short pages go through raw to preserve specific data (numbers, quotes).
      let summary: string;
      if (content.length <= SMART_SUMMARIZE_THRESHOLD) {
        summary = content;
      } else {
        try {
          summary = await summarizeContent(
            content,
            researchTopic,
            params.focus,
          );
        } catch {
          summary = truncateContent(content, 4000);
        }
      }

      // Stash verbatim excerpts so claim verification can ground citations to this URL
      // even when the model doesn't list it on a note's sourceUrls.
      captureExcerptsForUrl(urlExcerpts, params.url, { summary, content });

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
  const model = getUtilityModel();
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
      apiKey: getEnvApiKey(model.provider),
      reasoning: getUtilityReasoning(),
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
