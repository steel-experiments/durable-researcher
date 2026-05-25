# ABOUTME: EDGAR full-text search adapter — queries efts.sec.gov via host http_get and returns
# ABOUTME: a list of {title, url, snippet} dicts matching the SearchResult shape.
#
# Inputs (provided by the host):
#   query : str        — full-text search query
#   forms : list[str]  — optional form-type filter, e.g. ["10-K", "10-Q"]
#   limit : int        — max results to return
#
# Host functions used: http_get, url_encode.
# Note: do NOT use the `await` keyword — monty auto-awaits Promises returned by host fns.

import json

qs = "q=" + url_encode(query)
if forms:
    qs = qs + "&forms=" + url_encode(",".join(forms))

resp = http_get(
    "https://efts.sec.gov/LATEST/search-index?" + qs,
    {"Accept": "application/json"},
)

results = []
if resp["status"] == 200:
    data = json.loads(resp["body_text"])
    hits = data.get("hits", {}).get("hits", [])
    for hit in hits:
        if len(results) >= limit:
            break
        src = hit.get("_source", {})
        ciks = src.get("ciks") or []
        cik = ciks[0] if ciks else None
        accession = src.get("adsh") or hit.get("_id")
        if not cik or not accession:
            continue
        padded = cik.lstrip("0").zfill(10)
        no_dashes = accession.replace("-", "")
        url = (
            "https://www.sec.gov/Archives/edgar/data/"
            + str(int(padded)) + "/" + no_dashes + "/"
            + accession + "-index.htm"
        )
        names = src.get("display_names") or ["Unknown"]
        company = names[0]
        forms_list = src.get("forms") or []
        form = src.get("file_type") or (forms_list[0] if forms_list else "filing")
        filed = src.get("file_date", "")
        title = company + " - " + form
        if filed:
            title = title + " (filed " + filed + ")"
        snippet_str = "EDGAR filing: " + form
        if filed:
            snippet_str = snippet_str + ", " + filed
        snippet_str = snippet_str + " - " + company
        results.append({"title": title, "url": url, "snippet": snippet_str})

results
