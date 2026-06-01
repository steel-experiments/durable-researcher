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
import {
  isPaperLikeUrl,
  extractReferenceCandidates,
  type ReferenceQueue,
} from "../reference-queue.js";

const BrowseParams = Type.Object({
  url: Type.String({ description: "The URL to browse and extract content from" }),
  focus: Type.Optional(
    Type.String({
      description:
        "What to focus on when summarizing (e.g. 'error correction techniques', 'benchmark results')",
    }),
  ),
});

const SUMMARY_MAX_TOKENS = 700;

/** Content shorter than this is returned raw — preserves specific data, citations, named entities. */
const SMART_SUMMARIZE_THRESHOLD = 10000;

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

/** Outcome of browsing a single URL. */
export type BrowseOneResult = {
  text: string;
  title: string;
  meaningful: boolean;
  fromCache: boolean;
  details: Record<string, unknown>;
};

/**
 * Scrape one URL, summarize it, capture excerpts, and (when a reference queue is
 * provided and the page is paper-like) enqueue its citations for later chasing.
 * Shared by the browse_url tool and chase_references.
 */
export async function browseOne(opts: {
  client: Steel;
  url: string;
  topic: string;
  scrapedUrls: Set<string>;
  focus?: string;
  taskId?: string;
  urlExcerpts?: UrlExcerptStore;
  referenceQueue?: ReferenceQueue;
}): Promise<BrowseOneResult> {
  const { client, url, topic, scrapedUrls, focus, taskId, urlExcerpts, referenceQueue } = opts;

  let content: string;
  let title: string;
  let rawLength: number;

  const cached = taskId ? await getCachedBrowse(taskId, url).catch(() => null) : null;
  const fromCache = cached !== null;
  if (cached) {
    content = cached.content;
    title = cached.title;
    rawLength = cached.rawLength;
  } else {
    const scraped = await fetchBrowseContent(client, url);
    content = scraped.content;
    title = scraped.title;
    rawLength = scraped.rawLength;
  }
  const meaningful = isContentMeaningful(content);

  // Only cache meaningful content. Caching dead pages (bot blocks, paywalls,
  // empty responses) just makes resume blind to retries and pollutes the table.
  if (!cached && taskId && meaningful) {
    await setCachedBrowse(taskId, url, { title, content, rawLength }).catch(() => {});
  }

  if (!meaningful) {
    return {
      text: `Page "${title}" (${url}) had insufficient content (${rawLength} chars raw). The page may require authentication, be paywalled, or contain mostly non-text content.`,
      title,
      meaningful: false,
      fromCache,
      details: { url, title, rawLength, meaningful: false },
    };
  }

  scrapedUrls.add(url);

  // Harvest references from primary sources so chase_references can follow the citation graph.
  if (referenceQueue && isPaperLikeUrl(url)) {
    referenceQueue.add(extractReferenceCandidates(content));
  }

  // Smart summarization: only LLM-summarize long content.
  // Short pages go through raw to preserve specific data (numbers, quotes).
  let summary: string;
  if (content.length <= SMART_SUMMARIZE_THRESHOLD) {
    summary = content;
  } else {
    try {
      summary = await summarizeContent(content, topic, focus);
    } catch {
      summary = truncateContent(content, 4000);
    }
  }

  // Stash verbatim excerpts so claim verification can ground citations to this URL
  // even when the model doesn't list it on a note's sourceUrls.
  captureExcerptsForUrl(urlExcerpts, url, { summary, content });

  const refined: RefinedContent = {
    title,
    url,
    summary,
    rawLength,
    scrapedAt: Date.now(),
  };

  return {
    text: `## ${refined.title}\n**Source:** ${refined.url}\n**Raw length:** ${refined.rawLength} chars\n\n${refined.summary}`,
    title,
    meaningful: true,
    fromCache,
    details: refined as unknown as Record<string, unknown>,
  };
}

/** Create a browse_url tool that scrapes and summarizes page content. */
export function createBrowseTool(
  client: Steel,
  scrapedUrls: Set<string>,
  researchTopic: string,
  taskId?: string,
  urlExcerpts?: UrlExcerptStore,
  referenceQueue?: ReferenceQueue,
): AgentTool<typeof BrowseParams> {
  return {
    name: "browse_url",
    label: "Browse URL",
    description:
      "Navigate to a URL, scrape its content, and return a focused summary. Use the 'focus' parameter to guide what information to extract.",
    parameters: BrowseParams,
    execute: async (_toolCallId, params) => {
      const result = await browseOne({
        client,
        url: params.url,
        topic: researchTopic,
        scrapedUrls,
        focus: params.focus,
        taskId,
        urlExcerpts,
        referenceQueue,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: result.details,
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
