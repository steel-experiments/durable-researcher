// ABOUTME: Per-task store of verbatim excerpts keyed by URL — populated as the agent
// ABOUTME: browses pages. Used by claim verification to ground citations even when no
// ABOUTME: note explicitly attached the cited URL as a source.

import { MAX_EXCERPTS_PER_NOTE, MAX_EXCERPT_LENGTH } from "./types.js";

/** Default min length for a paragraph to be considered useful as an excerpt. */
const DEFAULT_MIN_PARAGRAPH_CHARS = 24;

/** Default cap on excerpts retained per URL. Matches the per-note cap. */
const DEFAULT_MAX_PER_URL = MAX_EXCERPTS_PER_NOTE;

/** Options for splitting page content into discrete excerpts. */
export type ExtractExcerptsOptions = {
  /** Max excerpts to return. */
  maxCount?: number;
  /** Per-excerpt character cap. */
  maxLength?: number;
  /** Minimum paragraph length to retain. */
  minLength?: number;
};

/**
 * Split raw page content into paragraph-sized verbatim excerpts. Used as a fallback
 * source of grounding text when the LLM summary did not produce a "Key excerpts" list
 * (e.g. for short pages that bypass summarization, or on cache hits).
 */
export function extractExcerptsFromContent(
  content: string,
  options: ExtractExcerptsOptions = {},
): string[] {
  const maxCount = options.maxCount ?? DEFAULT_MAX_PER_URL;
  const maxLength = options.maxLength ?? MAX_EXCERPT_LENGTH;
  const minLength = options.minLength ?? DEFAULT_MIN_PARAGRAPH_CHARS;
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  // Split on blank lines first; that's the natural paragraph boundary.
  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= minLength);

  // If paragraph splitting yielded nothing useful, fall back to the whole content as one excerpt.
  if (paragraphs.length === 0) {
    const single = trimmed.replace(/\s+/g, " ").trim();
    if (single.length === 0) return [];
    return [single.slice(0, maxLength)];
  }

  const out: string[] = [];
  for (const p of paragraphs) {
    if (out.length >= maxCount) break;
    out.push(p.length > maxLength ? p.slice(0, maxLength) : p);
  }
  return out;
}

const KEY_EXCERPTS_HEADING_RE =
  /(?:^|\r?\n)\s*(?:\d+\.\s*)?\*{0,2}Key\s+excerpts?\*{0,2}\s*:?\s*\r?\n/i;
const BULLET_PREFIX_RE = /^\s*(?:[*\-•]|\d+\.)\s+/;
const SURROUNDING_QUOTES_RE = /^["“”'`]+|["“”'`]+$/g;

/**
 * Parse the "Key excerpts" section out of the LLM-produced page summary. The summarize
 * prompt asks for verbatim quotes as bullet items under a "Key excerpts" heading.
 *
 * Strategy: after the heading, scan consecutive lines. Collect bullet items. Stop on
 * the first non-blank, non-bullet line — that's the start of the next section. This is
 * more robust than regex-matching the *next* heading, since LLMs vary on heading style
 * (`**X**`, `*X*`, plain `X:`, markdown `##`).
 */
export function parseKeyExcerptsFromSummary(summary: string): string[] {
  const match = summary.match(KEY_EXCERPTS_HEADING_RE);
  if (!match || match.index === undefined) return [];

  const start = match.index + match[0].length;
  const after = summary.slice(start);

  const out: string[] = [];
  for (const rawLine of after.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!BULLET_PREFIX_RE.test(line)) {
      // First non-bullet, non-blank line marks the next section. Stop here.
      break;
    }
    const stripped = line
      .replace(BULLET_PREFIX_RE, "")
      .trim()
      .replace(SURROUNDING_QUOTES_RE, "")
      .trim();
    if (stripped.length === 0) continue;
    out.push(stripped);
  }
  return out;
}

/** Public interface of the per-task URL excerpt store. */
export type UrlExcerptStore = {
  /** Merge `excerpts` into the store under `url`, deduping. */
  add(url: string, excerpts: string[]): void;
  /** Return excerpts for `url`, or an empty array if none. */
  get(url: string): string[];
  /** Count distinct URLs with at least one stored excerpt. */
  size(): number;
  /** Snapshot the contents as a read-only map. */
  asMap(): ReadonlyMap<string, string[]>;
};

/** Options controlling per-URL excerpt caps. */
export type UrlExcerptStoreOptions = {
  /** Max excerpts retained per URL. */
  maxPerUrl?: number;
};

/**
 * Capture excerpts for `url` into `store`. Prefers the LLM-produced "Key excerpts"
 * section of the summary (verbatim quotes), falling back to paragraph splits of the
 * raw scraped content. A no-op when the store is undefined or content is empty.
 */
export function captureExcerptsForUrl(
  store: UrlExcerptStore | undefined,
  url: string,
  source: { summary?: string; content?: string },
): void {
  if (!store) return;
  const fromSummary = source.summary
    ? parseKeyExcerptsFromSummary(source.summary)
    : [];
  if (fromSummary.length > 0) {
    store.add(url, fromSummary);
    return;
  }
  if (source.content && source.content.length > 0) {
    const fallback = extractExcerptsFromContent(source.content);
    if (fallback.length > 0) store.add(url, fallback);
  }
}

/**
 * Repopulate a store from cached browse content. Used on resume so the verifier has the
 * same grounding it would have had during the original run — even when the original
 * urlExcerpts state was lost with the crashed worker process.
 */
export async function rebuildUrlExcerptsFromCache(
  store: UrlExcerptStore,
  urls: Iterable<string>,
  loadCache: (url: string) => Promise<{ content: string } | null>,
): Promise<void> {
  for (const url of urls) {
    try {
      const cached = await loadCache(url);
      if (!cached || !cached.content) continue;
      captureExcerptsForUrl(store, url, { content: cached.content });
    } catch {
      // Best-effort — keep going on individual cache read failures.
    }
  }
}

/** Create a fresh store. */
export function createUrlExcerptStore(
  options: UrlExcerptStoreOptions = {},
): UrlExcerptStore {
  const maxPerUrl = options.maxPerUrl ?? DEFAULT_MAX_PER_URL;
  const data = new Map<string, string[]>();
  const seenKeys = new Map<string, Set<string>>();

  function normalizeKey(s: string): string {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }

  return {
    add(url, excerpts) {
      const key = url.trim();
      if (key.length === 0) return;
      const existing = data.get(key) ?? [];
      let seen = seenKeys.get(key);
      if (!seen) {
        seen = new Set<string>();
        for (const ex of existing) seen.add(normalizeKey(ex));
        seenKeys.set(key, seen);
      }
      for (const raw of excerpts) {
        if (existing.length >= maxPerUrl) break;
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        const nKey = normalizeKey(trimmed);
        if (seen.has(nKey)) continue;
        seen.add(nKey);
        existing.push(trimmed);
      }
      if (existing.length > 0) data.set(key, existing);
    },
    get(url) {
      return data.get(url) ?? [];
    },
    size() {
      return data.size;
    },
    asMap() {
      return data;
    },
  };
}
