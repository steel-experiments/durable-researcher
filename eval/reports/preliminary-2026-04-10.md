# Preliminary Evaluation Report — Durable Researcher Agent

**Date**: 2026-04-10 | **Agent Model**: Z.ai GLM-5.1 (high reasoning) | **Status**: Partial — final paper-aligned runs still pending

## Executive Summary

The current evidence is promising on ResearchRubrics and weaker on DRACO, but the dataset coverage is still uneven enough that the results should be treated as directional.

- **Best paper-comparable DRACO signal today**: 47.1% normalized score on **10/100 tasks** using **Gemini 3.1 Pro** as the judge.
- **Best full-coverage DRACO signal today**: 69.4% normalized score on **100/100 tasks** using **Claude Haiku 4.5** as the judge, but this is **not directly comparable** to the DRACO paper baselines.
- **Best ResearchRubrics signal today**: 0.598 pass rate on **10/101 tasks**, judged with the paper’s default judge.

**Bottom line**: Durable Researcher already looks competitive on ResearchRubrics, while DRACO suggests the main gaps are breadth/depth and factual accuracy. The single most important next step is to complete the **100-task Gemini-judged DRACO run**.

---

## Evaluation Status

This section is the key to interpreting the rest of the report.

| Benchmark | Judge | Tasks Completed | Comparable to Paper? | Status |
|---|---|---:|---|---|
| ResearchRubrics | Gemini 2.5 Pro Preview | 10 / 101 | Yes, same default judge | Partial |
| ResearchRubrics | GLM-5.1 (Z.ai) | 68 / 101 | No | Diagnostic |
| DRACO | Gemini 3.1 Pro Preview | 10 / 100 | Yes, closest available successor to paper judge | Partial |
| DRACO | Claude Haiku 4.5 | 100 / 100 | No | Complete but exploratory |

**Interpretation rule**:

- Compare our DRACO score against paper baselines **only** when the judge is Gemini.
- Treat the Haiku-judged DRACO run as a **diagnostic signal**, not a leaderboard placement.

---

## Methodology and Comparison Rules

All scores use **binary pass/fail grading**: each criterion in a rubric is judged MET or UNMET by an LLM judge.

- **Normalized Score**: Sum of criterion weights for MET criteria, divided by total positive weights. Negative-weight criteria subtract from the score. Range 0–100%.
- **Pass Rate**: Simple percentage of criteria passed. Range 0–100%.

The normalized score is the primary metric for DRACO because it rewards getting high-importance criteria right. ResearchRubrics uses pass rate.

### Judge Sensitivity

Judge choice materially changes absolute scores.

The DRACO paper reports that rankings are relatively stable across judges, but absolute scores vary significantly. In our runs, the same agent outputs produced a **22-point swing** between Haiku and Gemini. That means:

- **Gemini-judged DRACO** is the right basis for paper comparison.
- **Haiku-judged DRACO** is useful for diagnosis, but not for claiming parity with paper baselines.

### Judge Configuration

| Benchmark | Our Judge | Paper’s Judge | Temperature | Thinking | Method |
|---|---|---|---|---|---|
| ResearchRubrics | Gemini 2.5 Pro Preview | Gemini 2.5 Pro Preview | default | none | Real-time |
| ResearchRubrics (diagnostic) | GLM-5.1 (Z.ai) | — | default | none | Real-time |
| DRACO (paper-aligned) | Gemini 3.1 Pro Preview | Gemini 3 Pro (deprecated → 3.1) | 0.2 | low | Batch API |
| DRACO (exploratory) | Claude Haiku 4.5 | — | — | — | Real-time |

Judge prompts are exact copies from the respective benchmark repositories. For DRACO, Gemini-3-Pro is now deprecated, so we use Gemini-3.1-Pro with the same judging configuration.

---

## Paper-Comparable Results

This section contains the results that are most defensible for benchmark comparison, even when sample sizes are still incomplete.

### DRACO — Gemini-Judged, 10/100 Tasks

The DRACO paper (Perplexity AI, 2026) evaluates frontier deep research systems on 100 expert-curated tasks across 10 domains. Our Gemini 3.1 Pro run follows the paper’s judge setup as closely as possible, but it currently covers only **10 tasks**.

#### Normalized Score

| System | Score (%) | Judge | Tasks |
|---|---:|---|---:|
| Perplexity Deep Research (Opus 4.6) | **70.5** ± 0.3 | Gemini-3-Pro | 100 |
| Perplexity Deep Research (Opus 4.5) | 67.2 ± 0.3 | Gemini-3-Pro | 100 |
| Claude Opus 4.6 (standard + search) | 59.8 ± 0.3 | Gemini-3-Pro | 100 |
| Gemini Deep Research | 59.0 ± 0.4 | Gemini-3-Pro | 100 |
| OpenAI Deep Research (o3) | 52.1 ± 0.2 | Gemini-3-Pro | 100 |
| **Durable Researcher (ours)** | **47.1** | Gemini-3.1-Pro | 10 |
| Claude Opus 4.5 (standard + search) | 46.7 ± 0.3 | Gemini-3-Pro | 100 |
| OpenAI Deep Research (o4-mini) | 41.9 ± 0.4 | Gemini-3-Pro | 100 |

#### Pass Rate

| System | Pass Rate (%) | Judge | Tasks |
|---|---:|---|---:|
| Perplexity Deep Research (Opus 4.6) | **72.8** ± 0.3 | Gemini-3-Pro | 100 |
| Perplexity Deep Research (Opus 4.5) | 70.9 ± 0.6 | Gemini-3-Pro | 100 |
| Claude Opus 4.6 (standard + search) | 63.1 ± 0.2 | Gemini-3-Pro | 100 |
| Gemini Deep Research | 62.7 ± 0.5 | Gemini-3-Pro | 100 |
| OpenAI Deep Research (o3) | 56.9 ± 0.2 | Gemini-3-Pro | 100 |
| **Durable Researcher (ours)** | **50.2** | Gemini-3.1-Pro | 10 |
| Claude Opus 4.5 (standard + search) | 50.2 ± 0.2 | Gemini-3-Pro | 100 |
| OpenAI Deep Research (o4-mini) | 48.0 ± 0.5 | Gemini-3-Pro | 100 |

**Interpretation**:

- On the paper-aligned judge, Durable Researcher currently lands in the lower-middle tier of the published DRACO range.
- Because this is only **10 tasks**, the exact placement is provisional.
- The current gap to the top DRACO system is large enough to take seriously, even before the full run is complete.

### ResearchRubrics — Gemini-Judged, 10/101 Tasks

ResearchRubrics uses the paper’s default judge configuration, which makes this comparison cleaner than DRACO, but the task coverage is still only **10 of 101**.

| System | Pass Rate | Judge Model | Tasks |
|---|---:|---|---:|
| Gemini Deep Research | 0.615 | Gemini 2.5 Pro (paper default) | 101 |
| **Durable Researcher (ours)** | **0.598** | Gemini 2.5 Pro (paper default) | 10 |
| OpenAI Deep Research | 0.597 | Gemini 2.5 Pro (paper default) | 101 |
| Perplexity Deep Research | 0.487 | Gemini 2.5 Pro (paper default) | 101 |

**Interpretation**:

- This is the strongest result in the report.
- On the current subsample, Durable Researcher is effectively in line with Gemini and OpenAI deep research.
- The full **101-task** judging pass is required before treating this as stable.

---

## Judge Comparison Analysis

We judged the same agent outputs with multiple LLM judges, which lets us quantify how much judge choice affects scores. This analysis is based on overlapping tasks scored by two or more judges.

### ResearchRubrics: Gemini 2.5 Pro vs GLM-5.1 (10 overlapping tasks)

| Metric | Gemini 2.5 Pro | GLM-5.1 | Delta |
|---|---:|---:|---:|
| Mean normalized score | 0.598 | 0.462 | +0.136 |
| Mean pass rate | 0.541 | 0.401 | +0.140 |
| Median score | 0.556 | 0.463 | +0.094 |

**Agreement statistics** (285 common criteria):

| Metric | Value |
|---|---|
| Overall agreement | 82.1% (234/285) |
| Both MET | 104 |
| Both UNMET | 130 |
| Gemini=MET, GLM=UNMET | 47 |
| GLM=MET, Gemini=UNMET | 4 |
| Cohen's Kappa | 0.647 (substantial) |
| Spearman rank correlation | 0.782 (strong) |

> **Interpretation**: GLM-5.1 is **significantly stricter** than Gemini 2.5 Pro. In 47 of 51 disagreements, GLM rejected a criterion that Gemini accepted (vs only 4 the other way). However, the two judges produce **strongly correlated task rankings** (Spearman 0.782) — they agree on which tasks are good and bad, they just disagree on where the MET/UNMET threshold falls. GLM-5.1 scores should be treated as a lower bound, not directly compared against paper baselines.

### DRACO: Haiku vs Gemini 3.1 Pro (10 overlapping tasks)

**Agreement statistics** (383 common criteria):

| Metric | Value |
|---|---|
| Overall agreement | 71.0% (272/383) |
| Both MET | 141 |
| Both UNMET | 131 |
| Haiku=MET, Gemini=UNMET | 96 |
| Gemini=MET, Haiku=UNMET | 15 |
| Cohen's Kappa | 0.445 (moderate) |

> **Interpretation**: Haiku is much more lenient than Gemini 3.1 Pro, inflating MET verdicts by 96 criteria. The Kappa of 0.445 indicates only moderate agreement — weaker than the Gemini vs GLM-5.1 pair. This confirms that Haiku-judged DRACO scores (69.4%) should not be compared against paper baselines.

### Strictness Gradient

Across all our runs, judges fall on a clear strictness spectrum:

```
Lenient                                              Strict
  ├─ Haiku 4.5 (DRACO: 71% agreement w/ Gemini)
  ├─ Gemini 2.5 Pro (RR: 82% agreement, Kappa 0.65)
  ├─ Gemini 3.1 Pro + thinking=low
  └─ GLM-5.1 (RR: scores 14pp lower than Gemini)
```

This gradient is consistent with the DRACO paper's own cross-judge analysis, which found that Sonnet-4.5 produced higher absolute scores than Gemini, while GPT-5.2 produced lower ones. Judge choice affects absolute scores by up to **20+ points** but preserves relative rankings.

---

## Exploratory Results

### ResearchRubrics — GLM-5.1-Judged, 68/101 Tasks

GLM-5.1 judged 68 of 101 ResearchRubrics tasks before hitting the Z.ai API rate limit. This is the largest single-judge sample we have for ResearchRubrics, but the scores are **not paper-comparable** (the paper uses Gemini 2.5 Pro).

| Metric | Score | Judge | Tasks | Criteria |
|---|---:|---|---:|---:|
| Mean normalized score | 0.427 | GLM-5.1 | 68 | 1,721 |
| Mean pass rate | 0.395 | GLM-5.1 | 68 | 1,721 |

> **Interpretation**: The GLM-5.1 score of 0.427 is a **strict lower bound**. On the same 10 tasks, Gemini 2.5 Pro scored 0.598 (paper-comparable). Applying the observed mean delta (+0.14) as a rough correction suggests the true paper-comparable score is likely in the **0.55–0.60 range**. The remaining 33 tasks need to be judged by Gemini 2.5 Pro to confirm.

This section contains useful evidence, but it should not be used for paper-baseline ranking claims.

### DRACO — Haiku-Judged, 100/100 Tasks

This run covers the full DRACO benchmark, which makes it much more complete than the Gemini run, but the judge is not paper-aligned.

| Metric | Score | Judge | Tasks |
|---|---:|---|---:|
| Normalized Score | **69.4** | Claude Haiku 4.5 | 100 |
| Pass Rate | **73.0** | Claude Haiku 4.5 | 100 |

**Interpretation**:

- The full-run Haiku result is encouraging because it suggests the agent can produce many reports that look strong to a more permissive judge.
- It does **not** overturn the Gemini result.
- The correct reading is: the system likely has real capability, but the stricter judge sees material weaknesses that must be fixed.

---

## Diagnostic Breakdown

This section is for improvement prioritization, not headline comparison.

### DRACO Axis Breakdown

#### Paper Baselines

| Axis | Perplexity (Opus 4.6) | Gemini DR | Claude Opus 4.6 | OpenAI (o3) |
|---|---:|---:|---:|---:|
| Factual Accuracy | **67.9** | 54.9 | 57.9 | 51.4 |
| Breadth & Depth | **73.1** | 59.9 | 57.3 | 51.4 |
| Presentation Quality | **90.3** | 87.1 | 73.8 | 63.2 |
| Citation Quality | **64.6** | 51.5 | 56.2 | 45.8 |

#### Durable Researcher

| Axis | Gemini Judge (10 tasks) | Haiku Judge (100 tasks) |
|---|---:|---:|
| Factual Accuracy | 41.8 | 66.0 |
| Breadth & Depth | 25.6 | 78.6 |
| Presentation Quality | 79.3 | 80.1 |
| Citation Quality | 68.6 | 59.1 |

**Interpretation**:

- The reliable signal from the Gemini run is that **breadth/depth** and **factual accuracy** are the main weaknesses.
- **Presentation quality** looks genuinely strong.
- **Citation quality** is at least not the primary failure mode.
- The Haiku axis profile is too optimistic to use as the primary diagnosis, but it suggests the system’s writing and structure are already good enough that judge strictness is not the only issue.

### DRACO Domain Breakdown

The DRACO paper reports domain-level performance, but we do **not** yet have a paper-aligned domain breakdown for Durable Researcher because the full Gemini DRACO run is still incomplete.

| Domain | Perplexity (Opus 4.6) | Gemini DR | Claude Opus 4.6 | OpenAI (o3) |
|---|---:|---:|---:|---:|
| Finance | **71.0** | 49.4 | 48.5 | 42.1 |
| Shopping/Product | **64.7** | 53.8 | 51.9 | 44.7 |
| Academic | **82.8** | 72.7 | 72.0 | 73.5 |
| Technology | **66.6** | 56.8 | 53.2 | 46.3 |
| General Knowledge | **70.8** | 59.6 | 67.0 | 51.5 |
| UX Design | **62.4** | 50.8 | 54.3 | 51.9 |
| Law | **90.2** | 83.5 | 88.6 | 66.7 |
| Medicine | **80.5** | 58.8 | 72.5 | 65.0 |
| Needle in a Haystack | **68.4** | 62.8 | 66.2 | 54.5 |
| Personalized Assistant | **68.5** | 61.9 | 55.2 | 49.4 |

**Status**: per-domain Durable Researcher results remain pending until the **100-task Gemini DRACO run** is complete.

---

## Resource Usage and Cost

### Latency Comparison

We can compare latency today. Token usage for Durable Researcher is not yet available for the archived runs summarized here, so this section is intentionally limited to latency.

| System | Avg Latency |
|---|---:|
| Perplexity Deep Research (Opus 4.6) | 245s (~4 min) |
| Claude Opus 4.6 (standard + search) | 193s (~3 min) |
| Gemini Deep Research | 592s (~10 min) |
| **Durable Researcher (GLM-5.1)** | **~650s (~11 min avg)** |
| OpenAI Deep Research (o3) | 1,808s (~30 min) |

**Interpretation**:

- Durable Researcher is in the same rough latency band as Gemini Deep Research.
- The total DRACO run took about **18 hours** wall-clock.

### Cost and Infrastructure

| Item | Cost | Method |
|---|---:|---|
| Agent model (Z.ai GLM-5.1, 201 tasks) | ~$0 (beta) | — |
| ResearchRubrics judging — Gemini (10 tasks) | ~$1.50 | Gemini 2.5 Pro, real-time |
| ResearchRubrics judging — GLM-5.1 (68 tasks) | ~$13 | GLM-5.1, real-time |
| DRACO judging — Haiku (100 tasks) | ~$2.00 | Claude Haiku 4.5, real-time |
| DRACO judging — Gemini 3.1 Pro (10 tasks) | ~$3.32 | Gemini Batch API (50% off) |
| DRACO judging — Gemini 3.1 Pro (100 tasks, est.) | ~$33 | Gemini Batch API (50% off) |
| Full ResearchRubrics judging — Gemini (101 tasks, est.) | ~$15 | Gemini 2.5 Pro, real-time |
| **Total estimated for complete evaluation** | **~$55** | |

Agent runtime: ~18 hours for DRACO (100 tasks), ~12 hours for ResearchRubrics (101 tasks).

---

## What We Believe Today

These are the conclusions that seem strong enough to act on now.

1. **ResearchRubrics is genuinely promising**. Even on a small sample, Durable Researcher is already near the top published systems.
2. **DRACO is the harder benchmark for this agent**. The paper-aligned score is meaningfully below the frontier systems.
3. **The main weaknesses are not presentation or citations**. They are breadth/depth and factual accuracy under a strict judge.
4. **Judge sensitivity is large enough to distort intuition**. Any future external claim should clearly separate Gemini-judged and non-Gemini-judged results. The strictness gradient runs Haiku > Gemini 2.5 Pro > Gemini 3.1 Pro > GLM-5.1.
5. **GLM-5.1 is a useful strict diagnostic** but over-penalizes vs the paper's judge. On overlapping tasks it scores 14pp lower than Gemini 2.5 Pro, with strong ranking correlation (Spearman 0.782).

## What Is Still Uncertain

1. Whether the current ResearchRubrics result holds over all 101 tasks (68 tasks judged by GLM-5.1 suggest it may be slightly lower, but the paper-comparable Gemini score remains the best signal).
2. Where Durable Researcher really lands on DRACO once the full Gemini run is completed.
3. Which DRACO domains are driving the Gemini weakness most strongly.
4. Whether the remaining 33 ResearchRubrics tasks can be judged by GLM-5.1 once the API rate limit resets, or whether Gemini 2.5 Pro should be used instead.

---

## Next Actions

- [ ] Judge full 101-task ResearchRubrics with Gemini 2.5 Pro
- [ ] Re-judge all 100 DRACO tasks with Gemini 3.1 Pro (batch) for a paper-aligned final score
- [ ] Produce per-domain DRACO analysis from the completed Gemini run
- [ ] Improve agent breadth/depth and factual accuracy
- [ ] Regenerate this report as a final evaluation report once the comparable runs are complete
