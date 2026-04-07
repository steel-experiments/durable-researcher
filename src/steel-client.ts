// ABOUTME: Steel SDK wrapper for web scraping, screenshots, and multi-engine search.
// ABOUTME: Provides scrapeUrl, screenshotUrl, and multiEngineSearch with Google→Bing→DuckDuckGo fallback.

import Steel from "steel-sdk";
import type { ScrapeResponse } from "steel-sdk/resources/top-level.js";
import type { SearchResult } from "./types.js";
import { cleanContent, truncateContent } from "./content.js";

const MAX_CONTENT_CHARS = 25_000;

/** Create a Steel client using STEEL_API_KEY from env. */
export function createSteelClient(): Steel {
  const apiKey = process.env.STEEL_API_KEY;
  if (!apiKey) {
    throw new Error("STEEL_API_KEY environment variable is required");
  }
  return new Steel({ steelAPIKey: apiKey });
}

/** Scrape a URL and return cleaned markdown content + title. */
export async function scrapeUrl(
  client: Steel,
  url: string,
): Promise<{ content: string; title: string; rawLength: number }> {
  const response = await client.scrape({
    url,
    format: ["markdown"],
  });

  const raw = response.content?.markdown ?? "";
  const title = response.metadata?.title ?? url;
  const rawLength = raw.length;
  const content = truncateContent(cleanContent(raw), MAX_CONTENT_CHARS);

  return { content, title, rawLength };
}

/** Capture a screenshot of a URL, returning the hosted image URL. */
export async function screenshotUrl(
  client: Steel,
  url: string,
): Promise<string> {
  const response = await client.screenshot({ url });
  return response.url;
}

/** Search engines we try in order. Bing first since Google often CAPTCHAs Steel IPs. */
const SEARCH_ENGINES = [
  {
    name: "Bing",
    buildUrl: (q: string) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: "DuckDuckGo",
    buildUrl: (q: string) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  },
  {
    name: "Google",
    buildUrl: (q: string) =>
      `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10`,
  },
] as const;

/** Domains to exclude from search results. */
const BLOCKED_DOMAINS = new Set([
  // Search engines
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "bing.com",
  "duckduckgo.com",
  // Video/social platforms
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "reddit.com",
  // Messaging
  "whatsapp.com",
  "web.whatsapp.com",
  "telegram.org",
  // Shopping
  "amazon.com",
  "ebay.com",
  "alibaba.com",
  // Dictionaries/translation (match "agent" literally)
  "dict.leo.org",
  "leo.org",
  "dict.cc",
  "linguee.com",
  "deepl.com",
  "translate.google.com",
  // Google subdomains
  "accounts.google.com",
  "support.google.com",
  "maps.google.com",
  "play.google.com",
  // Generic noise
  "pinterest.com",
  "quora.com",
  "wikipedia.org",
]);

/** Check if a URL belongs to a blocked domain. */
function isBlockedUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return Array.from(BLOCKED_DOMAINS).some(
      (domain) => hostname === domain || hostname.endsWith("." + domain),
    );
  } catch {
    return true;
  }
}

/**
 * Unwrap tracking redirect URLs from search engines.
 * Bing uses /ck/a?...  DuckDuckGo uses /l/?uddg=...
 * Returns the original URL if it's not a tracking redirect.
 */
function unwrapTrackingUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    // DuckDuckGo: https://duckduckgo.com/l/?uddg=https%3A%2F%2F...
    if (parsed.hostname.includes("duckduckgo.com") && parsed.searchParams.has("uddg")) {
      return parsed.searchParams.get("uddg");
    }

    // Bing: https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly... (base64-encoded URL after "a1")
    if (parsed.hostname.includes("bing.com") && parsed.pathname === "/ck/a") {
      const u = parsed.searchParams.get("u");
      if (u && u.startsWith("a1")) {
        try {
          return atob(u.slice(2));
        } catch {
          return null;
        }
      }
    }

    // Google: /url?q=... tracking redirects
    if (parsed.hostname.includes("google.com") && parsed.searchParams.has("q") && parsed.pathname === "/url") {
      return parsed.searchParams.get("q");
    }

    return url;
  } catch {
    return url;
  }
}

/** Extract search results from a Steel scrape response. */
export function extractSearchResults(
  response: ScrapeResponse,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  // Strategy 1: Use structured links from the scrape response
  if (response.links?.length) {
    for (const link of response.links) {
      if (!link.url || !link.text) continue;
      if (!link.url.startsWith("http")) continue;

      // Unwrap tracking redirects to get the real destination URL
      const realUrl = unwrapTrackingUrl(link.url);
      if (!realUrl || !realUrl.startsWith("http")) continue;
      if (isBlockedUrl(realUrl)) continue;
      if (seenUrls.has(realUrl)) continue;

      seenUrls.add(realUrl);
      results.push({
        title: link.text.trim(),
        url: realUrl,
        snippet: "",
      });
    }
  }

  // Strategy 2: Parse markdown content for links if structured links are sparse
  if (results.length < 3 && response.content?.markdown) {
    const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(response.content.markdown)) !== null) {
      const [, text, rawUrl] = match;
      const realUrl = unwrapTrackingUrl(rawUrl);
      if (!realUrl || !realUrl.startsWith("http")) continue;
      if (isBlockedUrl(realUrl)) continue;
      if (seenUrls.has(realUrl)) continue;

      seenUrls.add(realUrl);
      results.push({
        title: text.trim(),
        url: realUrl,
        snippet: "",
      });
    }
  }

  return results.slice(0, 15);
}

/**
 * Score how relevant a search result is to the research topic.
 * Uses word overlap between the result's title+snippet and the topic keywords.
 * Returns a score between 0 and 1.
 */
/** Common words that match too broadly and add noise to relevance scoring. */
const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was", "were",
  "will", "have", "has", "had", "been", "being", "how", "what", "when", "where",
  "who", "which", "why", "can", "could", "would", "should", "not", "but", "also",
  "into", "about", "than", "then", "its", "any", "all", "each", "some", "make",
  "made", "needed", "need", "does", "more", "most", "other", "over", "such",
  "new", "use", "using", "used", "best", "top", "free", "online", "app",
]);

/** Strip common English suffixes for basic stemming. */
function roughStem(word: string): string {
  if (word.endsWith("tion") || word.endsWith("sion")) return word.slice(0, -3);
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ment") && word.length > 5) return word.slice(0, -4);
  if (word.endsWith("ness") && word.length > 5) return word.slice(0, -4);
  if (word.endsWith("able") && word.length > 5) return word.slice(0, -4);
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

/** Check if two words match, allowing for basic plural/suffix differences. */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const stemA = roughStem(a);
  const stemB = roughStem(b);
  return stemA === stemB || stemA === b || a === stemB;
}

/** Minimum number of topic keywords that must match for a result to be considered relevant. */
const MIN_KEYWORD_MATCHES = 2;

export function scoreRelevance(result: SearchResult, topic: string): number {
  const topicWords = new Set(
    topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
  if (topicWords.size === 0) return 0;

  // Include URL path segments in the matchable text — SERP snippets are often
  // empty from Steel scraping, but URLs like /research/building-effective-agents
  // contain useful signal.
  const urlPath = extractUrlWords(result.url);
  const resultText = `${result.title} ${result.snippet} ${urlPath}`.toLowerCase();
  const resultWords = resultText.split(/\s+/).filter((w) => w.length > 2);
  if (resultWords.length === 0) return 0;

  let matches = 0;
  for (const word of topicWords) {
    if (resultWords.some((rw) => wordsMatch(word, rw))) {
      matches++;
    }
  }

  // Require at least MIN_KEYWORD_MATCHES absolute matches to score at all.
  // A single keyword hit (e.g. "trustworthy" on a dictionary page) is noise.
  if (matches < MIN_KEYWORD_MATCHES) return 0;

  return matches / topicWords.size;
}

/** Extract meaningful words from a URL's hostname and path for relevance scoring. */
function extractUrlWords(url: string): string {
  try {
    const parsed = new URL(url);
    // Split hostname and path on common separators
    return `${parsed.hostname} ${parsed.pathname}`
      .replace(/[/.\-_]/g, " ");
  } catch {
    return "";
  }
}

/**
 * Filter search results by relevance to the topic (and optionally the search query).
 * Scores against both topic and query, taking the higher score — a result matching
 * the specific query is relevant even if it doesn't match the broad topic.
 * Returns only results above threshold; empty array if nothing qualifies.
 */
export function filterByRelevance(
  results: SearchResult[],
  topic: string,
  threshold = 0.3,
  query?: string,
): SearchResult[] {
  const scored = results.map((r) => {
    const topicScore = scoreRelevance(r, topic);
    const queryScore = query ? scoreRelevance(r, query) : 0;
    return { result: r, score: Math.max(topicScore, queryScore) };
  });
  scored.sort((a, b) => b.score - a.score);

  return scored.filter((s) => s.score >= threshold).map((s) => s.result);
}

/** Try multiple search engines in order, returning results from the first success. */
export async function multiEngineSearch(
  client: Steel,
  query: string,
): Promise<SearchResult[]> {
  for (const engine of SEARCH_ENGINES) {
    try {
      const url = engine.buildUrl(query);
      const response = await client.scrape({
        url,
        format: ["markdown"],
      });

      const results = extractSearchResults(response);
      if (results.length > 0) {
        return results;
      }
    } catch (error) {
      // Try next engine on failure
      continue;
    }
  }
  return [];
}
