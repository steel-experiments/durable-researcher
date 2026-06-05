// ABOUTME: Canonical URL keys for visited-source deduplication.
// ABOUTME: Keeps raw URLs fetchable while preventing harmless URL variants from re-browsing.

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "msclkid",
]);

/** Normalize a URL into a stable key for deduplication, not for display/fetching. */
export function normalizeUrlForDedup(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.hash = "";

    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();

    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }

    return parsed.toString();
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^https?:\/\/www\./, (prefix) => prefix.replace("www.", ""))
      .replace(/\/+$/, "");
  }
}

export function hasVisitedUrl(visited: Set<string>, url: string): boolean {
  const normalized = normalizeUrlForDedup(url);
  for (const seen of visited) {
    if (normalizeUrlForDedup(seen) === normalized) return true;
  }
  return false;
}

export function addVisitedUrl(visited: Set<string>, url: string): void {
  const trimmed = url.trim();
  if (trimmed && !hasVisitedUrl(visited, trimmed)) visited.add(trimmed);
}
