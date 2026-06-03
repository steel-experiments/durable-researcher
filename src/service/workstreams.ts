// ABOUTME: Parses an orchestrator-plan report into independent subagent workstreams.
// ABOUTME: Lets the planning step drive the fan-out decomposition instead of a fixed objective list.

/** Matches a workstream line, ignoring any leading list marker / numbering. */
const WORKSTREAM_RE = /^\s*(?:[-*]\s*|\d+[.)]\s*)?WORKSTREAM:\s*(.+)$/i;

/**
 * Extract `WORKSTREAM:`-marked objectives from an orchestrator plan, in order.
 * Trims surrounding whitespace, drops empty markers, and dedupes case-insensitively.
 * Returns at most `max` workstreams.
 */
export function parseWorkstreams(text: string, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(WORKSTREAM_RE);
    if (!match) continue;
    const objective = match[1].trim();
    if (!objective) continue;
    const key = objective.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(objective);
    if (out.length >= max) break;
  }
  return out;
}
