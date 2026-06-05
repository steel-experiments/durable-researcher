# Durable Researcher — Redesign Research & Reasoning

Status: research notes · Date: 2026-06-05 · Author: Niko + Claude

This document records the research, reasoning, and code findings that produced
`REDESIGN_SPEC.md`. It is the "show your work" companion: the spec says *what to
build*; this says *why we believe it*.

The investigation started from an external artifact — an analysis of a Claude
`/deep-research` run on a deliberately tricky question — and worked inward to
durable-researcher's actual implementation.

---

## 1. The seed artifact: the "bubble gum 5K" deep-research run

**Question asked:** *"What was the name of the 5K race hosted at the old Great
America theme park in California that had 'bubble gum' in its title?"*

**Outcome:** There is no race with the literal words "bubble gum." The answer is
**Bubba Gump Shrimp Company's "Run Forrest Run" 5K** at California's Great
America — "Bubba Gump" is a near-homophone of "bubble gum." The run delivered
this at *medium* confidence with an explicit caveat that the literal-title
framing was refuted.

The run used a multi-agent workflow: **54 agents across 5 phases, ~327s
wall-clock.**

| Phase | Agents | Role |
|---|---|---|
| Scope | 1 | decompose into 5 search angles |
| Search | 5 | one WebSearch per angle |
| Fetch | 14 | fetch sources, extract atomic falsifiable claims |
| Verify | 33 | 11 claims × 3 adversarial voters |
| Synthesize | 1 | merge survivors, write report |

---

## 2. How the discovery actually happened (mechanism, not magic)

Reconstructed from the subagent transcripts:

1. **The Scope agent took the premise literally.** It generated five queries all
   built around the literal string "bubble gum." No homophone hypothesis. The
   cleverness did **not** come from a-priori planning.

2. **The insight emerged from the search results, not deduction.** The earliest
   search agent saw a telling juxtaposition:
   - `Bubble Gum 5k` → Instagram/hashtag aggregator pages, **empty**.
   - `Bubba Gump Shrimp Company's Run Forrest Run 5K` → a **real** Yelp event at
     the right venue.

   The model pattern-matched the homophone from that asymmetry: literal query
   returns ghosts, phonetic neighbor returns a real, location-matching event.

3. **Redundancy made the catch robust.** 4 of the 5 search agents independently
   made the homophone leap. It was not one lucky agent — fan-out turned a
   low-probability insight into a near-certainty.

4. **An adversarial layer pushed back.** The fetch step atomized the finding
   into separable claims. The literal-equivalence claim — *"the race named Bubba
   Gump … contains 'bubble gum'-adjacent wordplay … the answer"* — was sent to a
   3-voter jury prompted to **refute** ("default refuted=true"). All three
   refuted it (0–3): "Bubba Gump" is a Forrest Gump shrimp-company reference, not
   "bubble gum." Architecturally correct: the system refused to assert a sloppy
   equivalence.

5. **The true facts survived and carried the conclusion.** Location, charity,
   and admission claims passed 3–0 / 2–1. The red-herring (national "Bubble Run"
   foam series) was ruled out 3–0.

---

## 3. The corrected mechanism: how the answer survived its own claim being killed

Initial reconstruction was wrong on one point. Synthesis did **not** receive
"only the surviving claims." The deep-research code shows two paths:

- **Path A — transparency block.** Killed claims are appended to the synthesis
  prompt under `## Refuted claims (for transparency)`. The killed Bubba-title
  claim (0–3) was literally in the prompt.

- **Path B — the dominant one — evidence riding on confirmed claims.** Each
  *confirmed* claim's full verifier evidence text is spliced into the synthesis
  block. Every surviving factual claim's evidence *volunteered the homophone
  conclusion as a caveat*:
  - (location) "…the actual race is 'Bubba Gump … Run Forrest Run 5K' — not
    'bubble gum.'"
  - (charity) "…a likely phonetic mishearing of 'Bubba Gump.'"
  - (admission) "…the 'bubble gum' premise is a homophone error…"

So the synthesizer was handed the answer four times over, embedded in the
evidence of claims about *other* facts. **The literal claim died; the conclusion
it carried did not** — because the verifiers were disciplined enough to confirm
their narrow fact while flagging the framing. This is emergent, not designed:
the schema happened to carry evidence forward, and the verifiers happened to be
careful.

**Deep lesson:** the harness does not succeed by finding the answer and
asserting it. It succeeds by letting the **finding layer (search)** and the
**skeptic layer (verify)** disagree, and structuring the data flow so the
synthesizer sees both the killed claim and the conclusion embedded in surviving
evidence. The answer emerged *from* the disagreement, not despite it.

---

## 4. deep-research.js architecture (the reference design)

One line: `Scope → pipeline(Search → URL-dedup → Fetch+Extract) → 3-vote Verify
→ Synthesize`.

Four tunable constants govern the whole thing:

```
VOTES_PER_CLAIM = 3        // adversarial jury size
REFUTATIONS_REQUIRED = 2   // ≥2 of 3 refutes kills a claim
MAX_FETCH = 15             // hard cap on pages fetched
MAX_VERIFY_CLAIMS = 25     // hard cap on claims sent to the jury
```

Key engineering properties:

- **Schema-constrained typed hand-offs.** Every phase is forced through a JSON
  Schema (SCOPE / SEARCH / EXTRACT / VERDICT / REPORT). No phase returns prose
  the next must parse. This is the backbone.
- **No-barrier pipeline.** `pipeline(angles, searchStage, fetchStage)` runs each
  angle through search→dedup→fetch independently; angle B fetches while angle D
  still searches. Shared mutable state (`seen` map, `fetchSlots`) is safe because
  JS is single-threaded and the dedup callback runs synchronously per item.
- **URL dedup via `normURL`** (strips `www.`, trailing slash, lowercases) — the
  same Yelp page found by 4 angles is fetched once.
- **Fetch budget** — once `fetchSlots` (15) is exhausted, medium/low results
  drop but high-relevance ones still pass.
- **Atomization (EXTRACT_SCHEMA)** — each source forced into 2–5 falsifiable
  claims, each with a direct quote + importance. *This is the step that
  separated true facts from the interpretive overreach.*
- **Adversarial jury (barrier).** Full claim pool must exist before voting.
  Parallel-of-parallel: every claim × 3 voters. Survival rule:
  `valid >= 2 && refuted < 2`; abstentions filtered first so an all-abstain claim
  cannot sneak through as "0 refutes."
- **Per-finding confidence rules** in REPORT_SCHEMA → medium confidence on split
  votes or secondary sources → mechanically honest hedging.
- **Graceful degradation.** No claims → return source list. All refuted →
  "inconclusive" + refuted list. Synthesis fails → raw verified claims. Never
  faceplants.

---

## 5. Mapping to durable-researcher (what we found in our code)

### 5.1 What the run validates (we already had the instincts)

| Run behavior | Our existing mechanism |
|---|---|
| Discounted "Bubble Gum 5k" as SEO/hashtag spam | `isQueryReflectionSpam` / `filterReflectionSpam` (`src/steel-client.ts:445`) |
| Lateral/homophone reasoning | `prompts/plan.hbs:15-62` (homophone/pun decoding, needle-prior, domain-anchoring) |
| Distrust of secondary sources | `sourceAuthority` tiering (`src/steel-client.ts:268`) |
| Honest "medium + premise refuted" framing | `feat(verify): multi-vote quorum` commit |
| Homophone answer ≠ lexical topic match | `mode === "lookup"` bypasses `filterByRelevance` (`scout.ts:71`, `prefetch.ts:153`) |
| Pipelined search→browse with dedup + budget | `src/tools/prefetch.ts` (semaphore, `scrapedUrls`/`browsingUrls`, `maxBudget`) |

We are ~80% of the way to deep-research's Phase 1 *mechanically*.

### 5.2 The core architectural divergence — verify

This was the central finding. Reading `src/tools/verify-claims.ts` end to end:

| | deep-research.js | durable-researcher |
|---|---|---|
| Unit verified | atomic falsifiable claim (`{claim, quote, importance}`) | a *report sentence* carrying a `[n]` marker (`parseCitations`, :135) |
| When | **before** synthesis | **after** synthesis |
| Question asked | "is this claim true under scrutiny?" (default refuted) | "does the cited excerpt back this sentence?" (`VERIFY_SYSTEM`, "be reasonable, not pedantic") |
| Output feeds | synthesis (survivors + evidence + killed-claim block) | a **rewrite loop** (`buildRewriteSteering`) |

Consequences:

1. **The ordering is inverted.** durable-researcher synthesizes first, then
   verifies citations; deep-research verifies claims first, then synthesizes from
   survivors. By the time our verifier runs, the report has already committed to
   its conclusion. Our architecture **structurally cannot reproduce** the
   emergent "kill the overreach, keep the facts, carry the conclusion" split.

2. **We check grounding, not inference.** The Bubba Gump kill was an
   *inferential* overreach. A report sentence "The race is the Bubba Gump … 5K,
   the answer to the bubble-gum question [3]" would **pass** our verifier — the
   Yelp source does say a Bubba Gump 5K exists, so the citation is grounded; the
   leap isn't a fact the source states or contradicts, so none of
   `VERIFY_SYSTEM`'s rejection cases (a/b/c at :566) fire. We catch hallucinated
   citations; we do not catch well-cited overclaims.

3. **Our skeptic is usually asleep.** The adversarial refuter only runs inside a
   0.1-wide borderline band (`passRate ∈ [0.7, 0.8]`,
   `src/tools/verify-claims.ts:450-453`). A correct cost optimization *for
   citation verification* — outside the band a flipped vote can't change pass/fail
   — but it means a confidently-wrong report that cites cleanly at 90% never wakes
   the skeptic. deep-research's jury votes on every claim, always.

**Both machines are valid; they answer different questions.** Ours: "is every
cited sentence grounded?" (anti-hallucination of citations). Theirs: "which
claims survive scrutiny, and what's the honest confidence?" (anti-overclaiming
of conclusions).

### 5.3 "Fans out queries, not cognition"

`prefetch.ts` fans out *queries* but pours all results into **one** agent's
context. The homophone leap therefore has one reasoner, not five. The run's 4/5
redundancy is impossible in a single loop. This is the structural ceiling — and
it is **orthogonal to verify**.

---

## 6. The model-ceiling memory, re-examined

The `lateral-puzzle-model-ceiling` memory says hard phonetic-pun lookups fail on
*model capability*, not prompt/plumbing.

The Bubba Gump run is a same-class problem (bubble gum → Bubba Gump) that
**succeeded** — which nuances the memory:

- The win came not from a smarter single model but from **fan-out redundancy**
  (4 independent shots) **+ an adversarial layer** to ratify the catch.
- Caveat in the other direction: the Bubba Gump target was a *real, well-indexed
  entity*; the failed puzzles may be genuinely unrecoverable. "Model can't do it
  single-shot" ≠ "model can't do it at all."

**Conclusion:** the ceiling is partly confounded with a *single-shot-architecture
ceiling*. Worth a controlled re-test of the failed puzzles under a fan-out
harness before treating it as settled. **Important:** verify does **not** help
these — they fail at the *finding* stage (answer never recovered), so the lever
is the finding layer (independent fan-out cognition + post-search lateral
re-interpretation), not the skeptic layer.

---

## 7. From findings to the generalizable thesis (avoiding overfitting)

Niko's constraint: propose improvements that generalize, not ones tuned to the
homophone problem space. Stepping back, the homophone-specific fixes (e.g.
"drop the borderline-band gate for lookup mode") are exactly the overfit move.

The generalizable observation is the one in §5.2 / `REDESIGN_SPEC.md §1`:
**the system is organized around documents and a final report; the best research
systems are organized around claims, evidence, and open questions.** Inverting
that — a structured claim/evidence ledger as the loop's spine — is the keystone,
and it improves synthesis / survey / extraction *more* than lookup.

The anti-overfitting mechanism itself is **a mode-balanced eval layer**: you
cannot tune to one query if every change is scored against a diverse, held-out
set across all modes. A general eval harness (`eval/`, Python/uv, ResearchRubrics
+ DRACO) already exists; the spec extends it rather than rebuilding it (see
§9.1). That is why the spec sequences it first.

See `REDESIGN_SPEC.md` for the actionable proposal and sequencing.

---

## 8. Key file references (as of this session)

- `src/classify.ts` — task-mode classifier (lookup/extraction/survey/synthesis) + heuristic overrides.
- `prompts/plan.hbs` — planning prompt: literal+lateral interpretations, needle-prior, domain-anchoring, lens-based query generation.
- `src/tools/prefetch.ts` — parallel search+browse fan-out, semaphore, budget, dedup.
- `src/tools/scout.ts` — combined search+browse; `searchAndBrowse` shared with `find_entity`.
- `src/steel-client.ts` — multi-engine search, relevance scoring, `sourceAuthority` tiering, reflection-spam filter, blocked domains.
- `src/tools/evaluate.ts` — mode-specific completion gating (count thresholds).
- `src/tools/find-entity.ts` — kind-tailored entity resolution to canonical sources.
- `src/tools/verify-claims.ts` — post-synthesis citation verification, borderline-band 3-vote refuter, contradiction checker, source-tier confidence caps, rewrite-steering loop.
- `eval/` — existing Python/uv eval harness (ResearchRubrics + DRACO, LLM-as-judge, five-stage resumable pipeline, baseline runs/reports).
- `src/types.ts` — `ResearchPlan` (:186, no coverage-map field), `Evidence` (:218) and `Claim` (:228) explanation/report artifacts (the model to migrate into the in-loop ledger).
- `src/tools/note.ts` — `take_note` (single prose finding, self-assigned confidence + tier cap).
- `src/message-projector.ts` — durability via message replay + projection (`projectMessage`, :38).

---

## 9. Post-draft validation corrections

The first draft of `REDESIGN_SPEC.md` was reviewed against the repo. Five
findings were raised and **all five validated against the code**; the spec was
patched accordingly. Recorded here so the reasoning trail reflects what was
wrong, not just the corrected conclusion.

### 9.1 (High) The eval harness already exists

The draft claimed "no held-out scorecard" and proposed a new `evals/` tree —
and said to "reuse the existing Vitest setup." Both wrong. `eval/` is a
Python/uv harness (`eval/README.md`, `eval/pyproject.toml`) with ResearchRubrics
(101 tasks) + DRACO (100 tasks), an LLM-as-judge, a resumable five-stage
pipeline, and completed baseline runs/reports. **Refinement:** the residual gap
is narrow and real — those suites are general/synthesis-leaning and judge-scored,
so they are *not* mode-balanced across lookup/extraction/survey/synthesis and do
*not* measure confidence calibration. Spec §2.1 reframed to "extend `eval/` with
a mode-balanced golden layer + a calibration metric."

### 9.2 (High) `Evidence` / `Claim` type names are already taken

`src/types.ts:218` (`Evidence`) and `:228` (`Claim`) already exist. The draft
introduced colliding new types. **Refinement:** the existing `Claim` already
carries `evidenceIds`, `excerptIds`, `confidence`, and
`verification?: {supported, reason}` — it is already a claim↔evidence graph,
just populated post-synthesis. So the right move is to **migrate this model to
be the in-loop ledger**, not rename to `LedgerClaim`/`LedgerEvidence` and fork.
Spec §3.1 rewritten.

Follow-up validation tightened that recommendation: do not make ledger-only
fields required on the existing report/explanation `Claim`, because
`src/explanation.ts` still builds plain post-synthesis claims. Use a
`ResearchClaim extends Claim` shape during migration. Also do not put a single
`supports: boolean` on aggregate `Evidence`; current evidence can span multiple
URLs/excerpts, so support/refute polarity belongs on a claim-evidence edge or
per-excerpt item.

### 9.3 (Medium) `take_note` is one prose finding, not atomic claims

`src/tools/note.ts:10-25` accepts one `{title, content, sourceUrls, confidence}`
with self-assigned confidence — wrong granularity for a claim ledger. Spec §3.2
added: atomization via a `record_claims` tool (preferred), a source-extraction
step, or a `take_note` fan-out.

### 9.4 (Medium) Coverage-map planning was underspecified

`ResearchPlan` (`src/types.ts:186`) has no coverage field, and `interpretations`
are literal/lateral *readings*, not required subquestions. Spec §3.4 added a
concrete `RequiredClaim` schema (`{id, question, status, claimIds}`) on
`plan_research`.

### 9.5 (Medium) Durability is replay+projection, not arbitrary checkpointing

`src/message-projector.ts:38-57` reconstructs state from replayed tool results.
**Decision recorded in spec §3.3:** the ledger is reconstructed *through the
projector* from `record_claims`/`take_note` results — not persisted as separate
Absurd steps — to keep a single replay-correctness model.

### Validated as-is

The central diagnosis held: post-synthesis citation parsing
(`verify-claims.ts:135`), agent-provided note confidence with only tier capping
(`note.ts:18`), threshold-based completion guidance (`evaluate.ts:13`), and the
borderline-band-gated refuter/contradiction work (`verify-claims.ts:447`).
