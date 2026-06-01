# Research Strategy Improvements

## Eval-Based Assessment

The current strategy is good, but uneven.

- `draco` is strong overall: mean score `0.694` across 100 tasks.
- `researchrubrics` is much shakier: mean score `0.598` across 10 tasks.
- `draco` section means:
  - `breadth-and-depth-of-analysis`: `0.786`
  - `presentation-quality`: `0.801`
  - `factual-accuracy`: `0.660`
  - `citation-quality`: `0.591`

This pattern suggests the system is already a capable synthesis engine, but not yet a robust exact-retrieval or primary-document extraction engine.

## What The Current Strategy Is Good At

- Broad, open-ended synthesis
- Multi-source comparison and explanation
- Well-structured, readable reports
- Practical planning and ideation tasks

Examples from local eval artifacts:

- Strong `researchrubrics` performance on startup ideation in [`eval/responses/researchrubrics/6847465956a0f6376a605433.md`](../eval/responses/researchrubrics/6847465956a0f6376a605433.md)
- Strong `draco` performance on tax-planning synthesis in [`eval/responses/draco/f004b46b-c0e7-4e86-a072-c7491328d538.md`](../eval/responses/draco/f004b46b-c0e7-4e86-a072-c7491328d538.md)
- Strong `draco` performance on low-connectivity telehealth design in [`eval/responses/draco/868f0410-07c9-4609-a7f6-2ad72d678006.md`](../eval/responses/draco/868f0410-07c9-4609-a7f6-2ad72d678006.md)

## Where The Strategy Breaks

### 1. Exact-answer retrieval

The system often behaves like a careful analyst when the task actually wants one resolved fact.

Example:

- [`eval/responses/draco/b3d9ac35-7d3f-4fd5-925e-bbaa40c0de51.md`](../eval/responses/draco/b3d9ac35-7d3f-4fd5-925e-bbaa40c0de51.md)

Observed failure mode:

- The system overcommits to broad research.
- It does not enumerate alternate interpretations early enough.
- It produces a detailed report instead of a direct answer or a tightly scoped verification attempt.

### 2. Primary-document extraction

The current search/browse/note loop is much better at understanding topics than extracting exact numbers from filings, reports, and data books.

Examples:

- [`eval/responses/draco/72e81ce6-8d1f-4143-90d5-d25d7a212c85.md`](../eval/responses/draco/72e81ce6-8d1f-4143-90d5-d25d7a212c85.md)
- [`eval/responses/draco/3a8db70a-d906-4bde-bf87-c0c74504409a.md`](../eval/responses/draco/3a8db70a-d906-4bde-bf87-c0c74504409a.md)
- [`eval/responses/researchrubrics/6847465956a0f6376a60543e.md`](../eval/responses/researchrubrics/6847465956a0f6376a60543e.md)

Observed failure mode:

- If exact tables or values are hard to access, the system falls back to qualitative synthesis.
- Benchmarks often expect exact figures, exact definitions, and exact source-of-record extraction.

### 3. Polished-report bias

The system defaults to a long, organized report even when a benchmark would reward:

- a short direct answer
- an extracted evidence table
- a precise calculation with minimal prose

This is good product behavior for some users, but it hurts exact retrieval tasks.

### 4. Weak task-mode selection

The same broad “deep research” loop is used too often.

Current strategy is effectively single-mode:

- plan
- prefetch
- note
- evaluate
- synthesize

That works for synthesis, but not for all research tasks.

## Core Diagnosis

The system is currently a good synthesizer with weak routing into:

- exact lookup
- primary-document extraction
- benchmark-style precision answering

The main problem is not hallucination.

In many weak-performing tasks, the system is honestly reporting uncertainty rather than inventing facts. That is the correct product instinct. The issue is that the strategy does not switch into the right retrieval mode early enough.

## Recommended Strategy Changes

## 1. Add Task Classification Before Planning

Before any planning/prefetch step, classify the prompt into one of:

- `lookup mode`
- `extraction mode`
- `synthesis mode`

Definitions:

- `lookup mode`: one exact answer, entity resolution, trivia-like factual recovery
- `extraction mode`: exact values from filings, PDFs, reports, datasets, tables
- `synthesis mode`: broad comparison, planning, overview, ideation, strategy

Why:

- Current breadth-first planning is overused.

## 2. Add A Different First Turn For Exact Tasks

For `lookup mode` and `extraction mode`, the first internal step should answer:

- What exact object am I trying to recover?
- What source type is most likely to contain it?
- What would a minimally complete answer include?
- What hypotheses should I test first?

This should happen before broad search fan-out.

## 3. Add Hypothesis Tracking For Ambiguous Prompts

For ambiguous fact-finding tasks, explicitly enumerate candidate interpretations and test them quickly.

Example for the Great America race task:

- literal phrase in race title
- sponsor name misheard
- phonetic clue
- venue/event archive match
- related race conflated with this one

Why:

- The current strategy tends to lock onto one interpretation too early.

## 4. Build A Stronger Primary-Source Acquisition Path

Priority source types that need dedicated handling:

- SEC / EDGAR
- SEDAR+
- XBRL / inline filing tables
- investor PDFs
- ESG reports / sustainability data books
- JS-rendered corporate sites

This likely matters more than changing the overall loop.

If the system cannot reliably acquire and parse the document of record, finance and ESG tasks will remain capped.

## 5. Add An Evidence-Table Stage For Extraction Tasks

For `extraction mode`, require an intermediate structured artifact before prose:

- metric
- value
- date / period
- source URL
- source section / page if available
- confidence

Then synthesize only after the evidence table is populated.

Why:

- This prevents drifting into qualitative summary when the task wants exact numbers.

## 6. Tighten Completion Criteria

Do not allow “enough coverage” if required fields are still missing.

Examples of missing-task checks:

- named quantities not extracted
- exact entity name unresolved
- required comparisons not normalized
- required date ranges not covered

This should feed into `evaluate_progress` and final-report gating.

## 7. Make Output Style Conditional On Task Type

Default answer style by mode:

- `lookup mode`: answer first, minimal support
- `extraction mode`: evidence table first, concise analysis second
- `synthesis mode`: structured report

Why:

- The current polished-report bias helps some evals but hurts others.

## 8. Keep The Existing Synthesis Loop Mostly Intact

The core loop is already good for:

- open-ended comparison
- planning
- ideation
- technical synthesis

The biggest gains should come from better routing and better primary-source retrieval, not from replacing the note/evaluate/report loop entirely.

## Prioritized Roadmap

### Highest Priority

1. Add task classification (`lookup` / `extraction` / `synthesis`)
2. Add a primary-document retrieval path for filings and PDFs
3. Add evidence-table generation for extraction tasks
4. Tighten stop conditions for required fields

### Medium Priority

5. Add hypothesis tracking for ambiguous fact tasks
6. Make answer style conditional on task mode

### Lower Priority

7. Tune the current synthesis prompts and planning heuristics
8. Improve report polish further

## Bottom Line

The strategy is already competitive for synthesis-heavy research.

It is not yet a general-purpose research engine because it lacks:

- robust task routing
- strong primary-document extraction
- precise exact-answer handling

The next phase should focus on making the system multi-modal in strategy, not just multi-step in execution.
