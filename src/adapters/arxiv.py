# ABOUTME: arxiv adapter — blessed from agent-authored variant 8a27d16a.
# ABOUTME: 1 runs in history, 1 successful. First authored 2026-05-25T19:17:10.229Z.
# Original purpose: Search arXiv for papers on 'durable execution'

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
            r"<author>\s*<name>(.*?)</name>\s*</author>", entry, re.DOTALL
        )
        published_match = re.search(r"<published>(.*?)</published>", entry)

        title = (title_match.group(1).strip() if title_match else "Untitled")
        title = re.sub(r"\s+", " ", title)
        summary = (summary_match.group(1).strip() if summary_match else "")
        summary = re.sub(r"\s+", " ", summary)[:300]
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

