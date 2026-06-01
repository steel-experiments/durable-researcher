# Documentation

Project documentation for Durable Researcher. The canonical entry point is the
[root README](../README.md); this folder holds deeper references, proposals, and
historical records.

## Reference

- [ARCHITECTURE.md](ARCHITECTURE.md) — system overview, agent loop, durable-turns
  pattern, tools. *(Predates the May service/API layer, survey mode, campaigns,
  and adapters — due for a refresh.)*
- [improvements.md](improvements.md) — eval-driven research-strategy roadmap.
  Some items (survey mode, extraction mode, citation verification) have since
  shipped.
- [api/openapi.json](api/openapi.json) — OpenAPI spec for the durable research run API.

## Proposals

Design docs for features not yet built (or only partially built):

- [proposals/structured-output.md](proposals/structured-output.md) — JSON-Schema
  structured output alongside markdown reports.
- [proposals/evidence-bundles.md](proposals/evidence-bundles.md) — portable
  evidence and provenance bundles.
- [proposals/cost-tracking.md](proposals/cost-tracking.md) — per-run USD cost
  accounting. *(Not yet implemented.)*

## Writing

- [writing/article-durable-researcher.md](writing/article-durable-researcher.md) —
  narrative article about building the agent.

## History

Point-in-time records, kept for context but no longer maintained:

- [history/dev-log.md](history/dev-log.md) — development log reconstructed from
  build sessions 1–7 (through April 2026).
- [history/code-review-2026-04.md](history/code-review-2026-04.md) — April code
  review. Its findings have since been resolved.

Evaluation reports live under [`../eval/reports/`](../eval/reports/).
