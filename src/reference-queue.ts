// ABOUTME: Bounded, deduplicated queue of reference candidates harvested from browsed papers.
// ABOUTME: Feeds the chase_references tool so a survey can follow a paper's citation graph.

import { hasVisitedUrl, normalizeUrlForDedup } from "./url-normalize.js";

/** A capped, order-preserving, deduplicated queue of reference strings (URLs or titles). */
export type ReferenceQueue = {
  add: (refs: string[]) => void;
  drain: (n: number) => string[];
  readonly size: number;
};

/** Max references retained — keeps the citation-chase bounded. */
export const MAX_REFERENCE_QUEUE = 30;

function dedupKey(ref: string): string {
  return /^https?:\/\//i.test(ref) ? normalizeUrlForDedup(ref) : ref.trim().toLowerCase();
}

/** Create an empty reference queue. `seen` is shared with scraped URLs to avoid re-queuing visited pages. */
export function createReferenceQueue(seen?: Set<string>): ReferenceQueue {
  const items: string[] = [];
  const queued = new Set<string>();

  return {
    add(refs: string[]) {
      for (const raw of refs) {
        const ref = raw.trim();
        const key = dedupKey(ref);
        if (!ref) continue;
        if (queued.has(key)) continue;
        if (seen && /^https?:\/\//i.test(ref) && hasVisitedUrl(seen, ref)) continue;
        if (items.length >= MAX_REFERENCE_QUEUE) break;
        queued.add(key);
        items.push(ref);
      }
    },
    drain(n: number) {
      return items.splice(0, Math.max(0, n));
    },
    get size() {
      return items.length;
    },
  };
}

/** Does this URL look like a primary research source worth chasing references from? */
export function isPaperLikeUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("arxiv.org") ||
    u.includes("doi.org") ||
    u.includes("aclanthology.org") ||
    u.includes("openreview.net") ||
    u.includes("semanticscholar.org") ||
    u.includes("dl.acm.org") ||
    u.includes("ieeexplore.ieee.org") ||
    u.endsWith(".pdf")
  );
}

/**
 * Extract reference candidates from raw page content using pure regex — no LLM call.
 * Pulls arXiv IDs (normalized to abs URLs) and bare http(s) URLs. Returns at most `max`
 * unique candidates. Deliberately conservative: better to miss a reference than to
 * enqueue noise the chase tool will waste a browse on.
 */
export function extractReferenceCandidates(content: string, max = MAX_REFERENCE_QUEUE): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (ref: string) => {
    if (out.length >= max) return;
    if (seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  };

  // arXiv IDs in "arXiv:2406.12045" form → canonical abs URL.
  for (const m of content.matchAll(/arxiv:\s*(\d{4}\.\d{4,5})(v\d+)?/gi)) {
    push(`https://arxiv.org/abs/${m[1]}`);
  }

  // Bare URLs. Strip common trailing punctuation from prose/markdown.
  for (const m of content.matchAll(/https?:\/\/[^\s<>()\[\]"']+/gi)) {
    const cleaned = m[0].replace(/[.,;:)\]}>"']+$/, "");
    push(cleaned);
  }

  return out;
}
