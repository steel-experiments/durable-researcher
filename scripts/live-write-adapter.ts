// ABOUTME: Live exercise of write_adapter — invokes it with a hand-rolled arXiv adapter,
// ABOUTME: simulating what the agent would do for a new source we haven't blessed yet.

import { createWriteAdapterTool } from "../src/tools/write-adapter.js";

// Imagine the LLM emitted this as its `code` argument. It hits arXiv's Atom XML API
// and pulls out title, authors, summary, abs URL. Uses only stdlib (re for parsing).
const ARXIV_CODE = `
import re

# arXiv's API returns Atom XML — small enough to regex without a parser.
url = (
    "http://export.arxiv.org/api/query?search_query="
    + url_encode(query)
    + "&max_results=" + str(max_results)
    + "&sortBy=relevance&sortOrder=descending"
)

resp = http_get(url, {"Accept": "application/atom+xml"})

papers = []
if resp["status"] == 200:
    body = resp["body_text"]
    # Split on entry boundaries — Atom puts each result in <entry>...</entry>.
    entries = re.findall(r"<entry>(.*?)</entry>", body, re.DOTALL)
    for entry in entries:
        title_match = re.search(r"<title>(.*?)</title>", entry, re.DOTALL)
        summary_match = re.search(r"<summary>(.*?)</summary>", entry, re.DOTALL)
        id_match = re.search(r"<id>(.*?)</id>", entry)
        author_matches = re.findall(
            r"<author>\\s*<name>(.*?)</name>\\s*</author>", entry, re.DOTALL
        )
        published_match = re.search(r"<published>(.*?)</published>", entry)

        title = (title_match.group(1).strip() if title_match else "Untitled")
        title = re.sub(r"\\s+", " ", title)
        summary = (summary_match.group(1).strip() if summary_match else "")
        summary = re.sub(r"\\s+", " ", summary)[:300]
        abs_url = id_match.group(1).strip() if id_match else ""
        published = published_match.group(1).strip() if published_match else ""
        authors = [a.strip() for a in author_matches]

        papers.append({
            "title": title,
            "url": abs_url,
            "authors": authors,
            "published": published,
            "summary": summary,
        })

papers
`;

async function main() {
  const tool = createWriteAdapterTool();
  const t0 = performance.now();
  const result = await tool.execute("live-arxiv-1", {
    source: "arxiv",
    purpose: "Search arXiv for papers on 'durable execution'",
    code: ARXIV_CODE,
    inputs: { query: "durable execution workflow", max_results: 5 },
  });
  const ms = Math.round(performance.now() - t0);

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  console.log(`tool result text (${ms}ms total):\n`);
  console.log(text.slice(0, 1200));
  console.log("\n--- details.output ---");
  const details = result.details as { source: string; durationMs: number; output: unknown };
  const papers = (details.output ?? []) as Array<{
    title: string;
    url: string;
    authors: string[];
    published: string;
    summary: string;
  }>;
  console.log(`source=${details.source}  durationMs=${details.durationMs}  papers=${papers.length}\n`);
  for (const [i, p] of papers.slice(0, 5).entries()) {
    console.log(`${i + 1}. ${p.title}`);
    console.log(`   ${p.url}  (${p.published.slice(0, 10)})`);
    console.log(`   ${p.authors.slice(0, 4).join(", ")}${p.authors.length > 4 ? ", …" : ""}`);
    console.log(`   ${p.summary.slice(0, 160)}…\n`);
  }
}

main().catch((e) => {
  console.error("live test failed:", e);
  process.exit(1);
});
