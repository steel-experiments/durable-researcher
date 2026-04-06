// ABOUTME: Content processing utilities for cleaning, truncating, and evaluating scraped text.
// ABOUTME: Used by the browse tool to prepare raw page content for LLM summarization.

/** Truncate text to maxChars, preserving word boundaries. */
export function truncateContent(
  text: string,
  maxChars: number,
  suffix = "\n\n[Content truncated]",
): string {
  if (text.length <= maxChars) return text;
  const cutoff = text.lastIndexOf(" ", maxChars);
  const breakPoint = cutoff > maxChars * 0.8 ? cutoff : maxChars;
  return text.slice(0, breakPoint) + suffix;
}

/** Normalize whitespace, collapse blank lines, strip common noise. */
export function cleanContent(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Check if content has enough substance to be worth summarizing. */
export function isContentMeaningful(
  text: string,
  minWords = 50,
  minLength = 200,
): boolean {
  if (text.length < minLength) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < minWords) return false;

  // Check for content diversity — low uniqueness ratio suggests boilerplate
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const uniqueWords = new Set(words);
  const uniquenessRatio = uniqueWords.size / words.length;
  if (uniquenessRatio < 0.2) return false;

  return true;
}

/** Rough token estimate: 1 token ≈ 4 characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
