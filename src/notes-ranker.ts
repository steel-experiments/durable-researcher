// ABOUTME: Pure functions for note ranking and deduplication via trigram similarity.
// ABOUTME: Detects near-duplicate notes, merges them, and ranks by confidence/source diversity.

import type { ResearchNote } from "./types.js";
import { MAX_EXCERPTS_PER_NOTE } from "./types.js";

/** Merge two excerpt lists, dedup by trimmed lowercase, preserve order, cap at MAX_EXCERPTS_PER_NOTE. */
function mergeExcerpts(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ex of [...(a ?? []), ...(b ?? [])]) {
    const key = ex.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ex);
    if (out.length >= MAX_EXCERPTS_PER_NOTE) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Extract word trigrams from a string for similarity comparison. */
function wordTrigrams(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 3) return new Set();
  const trigrams = new Set<string>();
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return trigrams;
}

/** Compute Jaccard similarity between two strings using word trigrams. */
export function computeSimilarity(a: string, b: string): number {
  return computeTrigramSimilarity(wordTrigrams(a), wordTrigrams(b));
}

/** Compute Jaccard similarity between two pre-computed trigram sets. */
function computeTrigramSimilarity(trigramsA: Set<string>, trigramsB: Set<string>): number {
  if (trigramsA.size === 0 || trigramsB.size === 0) return 0;

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }

  const union = trigramsA.size + trigramsB.size - intersection;
  if (union === 0) return 0;

  return intersection / union;
}

/** Find pairs of notes whose content similarity exceeds the threshold. */
export function findDuplicatePairs(
  notes: ResearchNote[],
  threshold = 0.6,
): [number, number][] {
  // Pre-compute trigrams once per note to avoid redundant tokenization
  const trigramCache = notes.map((n) => wordTrigrams(n.content));

  const pairs: [number, number][] = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const sim = computeTrigramSimilarity(trigramCache[i], trigramCache[j]);
      if (sim >= threshold) {
        pairs.push([i, j]);
      }
    }
  }
  return pairs;
}

const CONFIDENCE_RANK: Record<ResearchNote["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Merge two notes: keep the longer content (and its title),
 * union source URLs, and take the higher confidence.
 */
export function mergeNotes(a: ResearchNote, b: ResearchNote): ResearchNote {
  const primary = a.content.length >= b.content.length ? a : b;
  const secondary = primary === a ? b : a;

  const urlSet = new Set([...primary.sourceUrls, ...secondary.sourceUrls]);

  const confidence = CONFIDENCE_RANK[a.confidence] >= CONFIDENCE_RANK[b.confidence]
    ? a.confidence
    : b.confidence;

  const keyExcerpts = mergeExcerpts(primary.keyExcerpts, secondary.keyExcerpts);

  return {
    title: primary.title,
    content: primary.content,
    sourceUrls: Array.from(urlSet),
    confidence,
    ...(keyExcerpts ? { keyExcerpts } : {}),
  };
}

/**
 * Deduplicate notes by iteratively merging pairs that exceed the similarity threshold.
 * Returns a new array with duplicates merged.
 */
export function deduplicateNotes(
  notes: ResearchNote[],
  threshold = 0.6,
): ResearchNote[] {
  if (notes.length <= 1) return [...notes];

  let working = [...notes];
  let merged = true;

  while (merged) {
    merged = false;
    const pairs = findDuplicatePairs(working, threshold);
    if (pairs.length === 0) break;

    const [i, j] = pairs[0];
    const mergedNote = mergeNotes(working[i], working[j]);

    // Remove both originals (j first since it's higher index) and add merged
    working.splice(j, 1);
    working.splice(i, 1);
    working.push(mergedNote);
    merged = true;
  }

  return working;
}

/**
 * Rank notes by quality: confidence (high > medium > low),
 * then source count (more = better), then content length (longer = better).
 * Returns a new sorted array without mutating the input.
 */
export function rankNotes(notes: ResearchNote[]): ResearchNote[] {
  return [...notes].sort((a, b) => {
    // Confidence: higher is better
    const confDiff = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (confDiff !== 0) return confDiff;

    // Source count: more is better
    const srcDiff = b.sourceUrls.length - a.sourceUrls.length;
    if (srcDiff !== 0) return srcDiff;

    // Content length: longer is better
    return b.content.length - a.content.length;
  });
}
