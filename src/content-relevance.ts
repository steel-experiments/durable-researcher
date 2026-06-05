// ABOUTME: Scores browsed page content against the research topic.
// ABOUTME: Complements SERP-title relevance with a signal from the actual fetched page.

import { scoreRelevance } from "./steel-client.js";

export type ContentRelevance = {
  score: number;
  relevant: boolean;
};

const CONTENT_RELEVANCE_THRESHOLD = 0.2;

export function assessContentRelevance(input: {
  title: string;
  url: string;
  content: string;
  topic: string;
}): ContentRelevance {
  if (!input.topic.trim()) return { score: 1, relevant: true };
  const score = scoreRelevance(
    {
      title: input.title,
      url: input.url,
      snippet: input.content.slice(0, 4000),
    },
    input.topic,
  );
  return {
    score,
    relevant: score >= CONTENT_RELEVANCE_THRESHOLD,
  };
}
