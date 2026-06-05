# Durable Researcher — Redesign Spec

Status: proposal · Date: 2026-06-05 · Author: Niko + Claude

This spec proposes a set of generalizable improvements to durable-researcher.
It is deliberately **not** tuned to any one query shape (lookup vs. survey vs.
synthesis). The companion document `REDESIGN_SPEC_RESEARCH.md` records the
research, reasoning, and code findings that produced it.

---

## 1. Framing thesis

> **durable-researcher is organized around *documents and a final report*.
> The best research systems are organized around *claims, evidence, and open
> questions*.**

Trace the current data flow:

```
search → browse → write prose notes (self-assigned confidence)
       → synthesize report → verify the report's citations
```

The unit of work is the **document**; the deliverable is **prose**. Claims only
become first-class *after* synthesis, when `parseCitations` reverse-engineers
them out of the finished report (`src/tools/verify-claims.ts:135`).

That ordering is the root cause of four weaknesses that span every task mode:

1. **Honesty / overclaiming** — the report commits to a conclusion before any
   skeptic sees it; verification can only police citation-grounding, not the
   soundness of the inference.
2. **Confidence calibration** — `note.confidence` is the agent's discretion,
   not derived from evidence.
3. **Contradiction handling** — contradictions surface (if at all) post-hoc, in
   a narrow band, instead of during research.
4. **Completion gating** — gated on brittle count thresholds
   (`src/tools/evaluate.ts`) rather than coverage of the question.

**The keystone change is to invert the ordering: make a structured
claim/evidence ledger the spine of the loop.** Most other improvements hang off
it. This is not a lateral-puzzle fix — it helps synthesis, survey, and
extraction more than lookup. It fits the durable model: durability today is
**message replay + projection** (`src/message-projector.ts:38`), not arbitrary
state checkpointing, so the ledger is *reconstructed through the projector* from
tool-call results — exactly how `notes` are rebuilt on resume today (see §3.3).

---

## 2. The anti-overfitting prerequisite (do this first)

### 2.1 Extend the existing eval harness with a mode-balanced golden layer

**What already exists (do not rebuild).** `eval/` is a Python/uv harness
(`eval/README.md`, `eval/pyproject.toml`) that benchmarks durable-researcher
against two open-source deep-research suites via LLM-as-judge, with a resumable
five-stage pipeline (download → run → judge → score → report), completed
baselines under `eval/runs/` and `eval/reports/`:

| Benchmark | Tasks | Measures |
|---|---|---|
| ResearchRubrics (Scale AI) | 101 | factual grounding, reasoning, completeness, clarity |
| DRACO (Perplexity) | 100 | factual accuracy, breadth/depth, presentation, citations |

**The real gap.** Those suites are general and synthesis-leaning, scored by an
LLM judge against prose rubrics. They are **not mode-balanced** across
`lookup / extraction / survey / synthesis`, and judge rubrics do **not** measure
**confidence calibration**. So the residual work is narrow:

1. **A mode-balanced golden set** — fixtures with deterministic answer keys
   spanning all four task modes (not just judge-scored prose), so per-mode
   regressions are visible.
2. **A calibration metric** — when the agent says "high," is it right?
   (reliability diagram / Brier-style score over the set), wired into the
   existing score → report stages.

**Why first.** It de-risks every other item and makes overfitting structurally
hard: you cannot tune to one query if every change is scored against a diverse,
held-out set across all modes. Every later section is then measured, not argued.

**Deliverable.** New task fixtures + answer keys added under `eval/data/` (or a
sibling), plus a calibration scorer added to the existing pipeline — extending
the Python harness, not a parallel TypeScript/Vitest tree. Tasks call the real
agent loop (no mocks, per project policy).

---

## 3. The keystone: structured research state

### 3.1 Claim / evidence ledger — migrate the existing model, don't fork it

**Do not introduce new `Evidence` / `Claim` types — those names are taken.**
`src/types.ts:218` (`Evidence`) and `:228` (`Claim`) already exist for
explanation/report artifacts, and the existing `Claim` is *already* a
claim↔evidence graph: it carries `evidenceIds`, `excerptIds`, `confidence`, and
`verification?: {supported, reason}`. Today it is populated **post-synthesis** as
a report artifact. The redesign **migrates this same model to be the in-loop
ledger**, populated *during* research — unify, don't run two parallel models.

Use a ledger-specific extension of the existing `Claim` shape rather than making
new fields required on every current report/explanation claim. Current
explanation claims are still built post-synthesis and should remain valid during
migration.

```ts
// extends src/types.ts Claim — populated in-loop, not just post-synthesis.
// Report/explanation claims may remain plain Claim until they are migrated.
type ResearchClaim = Claim & {
  status: "open" | "supported" | "contested" | "refuted";  // NEW
  independentCorroboration: number;                          // NEW — see 4.2
};
```

Do **not** put support/refute polarity on the current aggregate `Evidence` type
directly: it can contain multiple `sourceUrls` / `excerptIds`, so a single
`supports: boolean` would become ambiguous. Instead introduce an edge or
per-excerpt item:

```ts
type ClaimEvidenceLink = {
  claimId: string;
  evidenceId: string;
  excerptId: string;
  sourceUrl: string;
  supports: boolean;     // supporting vs. contradicting this specific claim
  tier: SourceTier;      // primary|secondary|blog|forum|unreliable
  publishedAt?: string;  // see 5.2
};
```

The report becomes a *projection* of `ResearchClaim` + evidence links, not a
separate source-of-truth model.

### 3.2 Atomization — `take_note` must emit claims, not one prose finding

**Problem.** `take_note` (`src/tools/note.ts:10-25`) records a single prose
finding `{title, content, sourceUrls, confidence, keyExcerpts, sourceTier}` with
**self-assigned** confidence. That is the wrong granularity for a claim ledger —
one note bundles many facts, so it cannot be adjudicated or corroborated per
claim.

**Proposal (pick one, implement explicitly):**

- **(a) `record_claims` tool** — replaces/augments `take_note`; accepts an array
  of atomic `{text, excerpt, sourceUrl, supports}` entries that map 1:1 to
  ledger `Claim`/`Evidence`. *Preferred* — cleanest mapping, mirrors
  deep-research's EXTRACT step.
- **(b) source-extraction step** — after browse, a step decomposes the page into
  atomic claims automatically (no agent discretion).
- **(c) `take_note` fan-out** — keep the tool surface, but have it emit multiple
  atomic ledger entries from one call.

Confidence on each claim is **derived** (§4.1), not passed in — so the existing
`confidence` param on `take_note` shrinks to a hint at most.

### 3.3 Durability — reconstruct through the projector, not via new steps

**Constraint.** Durability today is **message replay + projection**: on resume,
`projectMessage` (`src/message-projector.ts:38-57`) rebuilds `notes` and
`scrapedUrls` from replayed `take_note` / `browse_url` tool results. There is no
arbitrary state checkpoint.

**Decision.** The ledger is reconstructed **through the projector** from
`record_claims` (or `take_note`) tool-call results — the same mechanism that
rebuilds notes today — **not** persisted as separate Absurd steps. This keeps a
single replay-correctness model and the existing projection test approach
intact; a parallel persisted-state path would be a second durability mechanism
to keep in sync. The projector gains claim/evidence/open-question handling
alongside its current note handling.

**Files touched.** Extend `src/types.ts` (Claim/Evidence fields);
`src/tools/note.ts` → `record_claims` (§3.2); `src/message-projector.ts`
projects ledger deltas; `src/tools/evaluate.ts` reads the ledger.

### 3.4 Coverage map, replacing count-threshold completion

**Problem.** `evaluate.ts` gates on proxies — "≥10 systems and ≥10 benchmarks"
for survey, "exact answer in a high-confidence note" for lookup. These are
stand-ins for the real question: *have I covered what this question decomposes
into?*

**Proposal.** Add a coverage map to the plan. `ResearchPlan`
(`src/types.ts:186`) currently has no such field — its `interpretations` are
literal/lateral *readings*, **not** required subquestions. Add an explicit
schema to `plan_research`:

```ts
// added to ResearchPlan
type RequiredClaim = {
  id: string;
  question: string;                              // the subquestion to answer
  status: "open" | "answered" | "contradicted";  // tracked across the loop
  claimIds: string[];                            // ledger claims that address it
};
// ResearchPlan.requiredClaims?: RequiredClaim[]
```

Completion = coverage of `requiredClaims`, not a magic number. **Generalizes
across all four modes** and removes the "loop churns to step-budget" failure:
"open questions remain" is concrete and inspectable, not a vibe.

---

## 4. Correctness and honesty (hang off the ledger)

### 4.1 Evidence-derived confidence

**Problem.** `note.confidence` is agent discretion, capped by source tier
(verify commit #4). Whether `high/medium/low` is *calibrated* is unknown and
unmeasured.

**Proposal.** Confidence becomes a mechanical function of the ledger:

```
confidence = f(independentCorroboration, sourceTier, recency, contradictionPresence)
```

Auditable, consistent, and it gives the deep-research property of "verification
arithmetic → honest hedging" for free. Measured by the calibration score in 2.1.

### 4.2 Independence-aware corroboration

**Problem.** `evaluate.ts` counts unique *domains*, but two high-tier domains
are not independent if one syndicates the other or both run the same wire story.

**Proposal.** Detect circular / syndicated sourcing and weight corroboration by
independence. `independentCorroboration` on a claim counts genuinely independent
sources, not raw domain count. Matters most for synthesis and extraction
(conflicting figures), least for lookups.

### 4.3 Contradiction as a first-class, in-loop concern

**Problem.** `ContradictionChecker` is good but bolted to the end and only fires
in a 0.1-wide borderline band on strong claims
(`src/tools/verify-claims.ts:502-509`).

**Proposal.** Surface contradictions *during* research, attach them to the
ledger claim (`status: "contested"`), and let the agent resolve or report them.
Keep the existing post-report citation verification as a final integrity gate —
it is genuinely good at that job; this adds an in-loop layer above it.

---

## 5. Depth and adaptivity

### 5.1 Adaptive search strategy

**Problem.** `searchStrategy` (breadth/depth) is fixed at plan time.

**Proposal.** Drive strategy from ledger state: broaden when claims are thin,
drill when a claim is `contested`, and spend the next query on *independent
corroboration of an open claim* rather than re-confirming a settled one.
`prefetch.ts` already emits "0 browsed → switch angle," which is the primitive
form of this signal.

### 5.2 Temporal / recency awareness

Capture source publication dates into `Evidence.publishedAt` and reason about
stale-vs-current (e.g. a 2023 leaderboard vs. a 2026 one). Feeds the recency
term in 4.1. High value for synthesis and survey.

### 5.3 Selective independence (the *measured* version of fan-out)

The deep-research redundancy lesson generalizes — independent perspectives
reduce blind spots on any hard question — but full multi-agent is a large,
expensive change against the single-durable-loop design. **Do not grab it
reflexively.**

Low-regret version: a **second independent synthesis pass** over the same
ledger, reconciled/diffed against the first. Disagreement between the two is
both a quality signal and an honesty check — most of the "two layers disagree"
value without a 54-agent harness. Gate this behind the eval harness so we can
prove it pays before paying for it.

---

## 6. Smaller wins (independent of the above)

- **`normURL` dedup.** `scrapedUrls` is exact-matched, so `yelp.com/x` and
  `www.yelp.com/x/` get fetched twice. Normalize (strip `www.`, trailing slash,
  lowercase) before dedup in `src/tools/prefetch.ts` and `src/tools/scout.ts`.
- **Content-grounded relevance.** Let the *actual browsed content* feed a
  relevance judgment back to the agent, instead of relying entirely on lexical
  SERP-title overlap (`scoreRelevance` in `src/steel-client.ts`), which is
  brittle outside English keyword matching.

---

## 7. Suggested sequencing

1. **Eval harness** (§2) — de-risks everything, prevents overfitting.
2. **Claim/evidence ledger** (§3) — the keystone; §4 hangs off it.
3. **Evidence-derived confidence + in-loop contradiction** (§4) —
   correctness/honesty.
4. **Adaptive search + temporal awareness + selective second synthesis** (§5) —
   depth.
5. **Smaller wins** (§6) — land opportunistically; no dependency.

## 8. Explicit non-goals / things to preserve

- **Keep the single durable loop.** Durability-by-checkpoint is a core design
  choice; the ledger fits it, full multi-agent fights it.
- **Keep post-report citation verification.** It is the right machine for
  citation integrity; the ledger adds an in-loop layer, it does not replace it.
- **Do not tune to lateral/needle puzzles.** They are one cell of a 4×N matrix;
  the eval set keeps us honest about the whole matrix.
- **Do not rebuild the eval harness.** Extend the existing `eval/` Python
  pipeline (§2.1); a parallel TypeScript/Vitest eval tree would fork measurement.
- **Do not fork the claim/evidence model.** Migrate the existing `Claim` /
  `Evidence` types in `src/types.ts` (§3.1); two parallel models will diverge.
