# Preliminary Evaluation Report — Durable Researcher Agent

**Date**: 2026-04-10 | **Agent Model**: Z.ai GLM-5.1 (high reasoning) | **Status**: Partial — full runs pending

## Summary

We evaluated our durable-researcher agent against two public research-quality benchmarks: **ResearchRubrics** (101 tasks, 2,593 criteria) and **DRACO** (100 tasks, 3,934 criteria across 10 domains). Early results show our agent is competitive with established deep-research products on ResearchRubrics, while DRACO scores suggest significant room for improvement — consistent with the benchmark's difficulty (best-system saturation ~67%).

**Caveat**: ResearchRubrics results cover only 10 of 101 tasks. DRACO results span all 100 tasks but were judged by two models with a 71% agreement rate, indicating score sensitivity to judge choice. We recommend treating these as directional, not final.

---

## ResearchRubrics — Binary Criterion Pass Rate

| System | Pass Rate | Judge Model | Tasks |
|---|---|---|---|
| Gemini Deep Research | 0.615 | Paper default | 101 |
| **Durable Researcher (ours)** | **0.598** | Gemini 2.5 Pro | 10 |
| OpenAI Deep Research | 0.597 | Paper default | 101 |
| Perplexity Deep Research | 0.487 | Paper default | 101 |

*Paper baselines from ResearchRubrics Table 5 (binary grading). Our score is a 10-task subsample.*

Our agent scores within 2 points of Gemini Deep Research and OpenAI Deep Research on this subsample. This is promising but not statistically conclusive given the small sample (10/101 tasks). A full run is needed to confirm.

---

## DRACO — Criterion Satisfaction Rate

| Configuration | Score | Criteria Met | Judge Model | Tasks |
|---|---|---|---|---|
| Paper best-system saturation | ~0.67 | — | Paper default | 100 |
| Durable Researcher (Haiku judge) | 0.694 | 2,523 / 3,934 | Claude Haiku 4.5 | 100 |
| Durable Researcher (Gemini 3.1 Pro judge) | 0.471 | 156 / 383 | Gemini 3.1 Pro | 10 |

**Judge disagreement analysis** (10-task subsample, 383 criteria):
- Overall agreement: 71% (272/383)
- Haiku = MET, Gemini = UNMET: 96 cases (Haiku is more lenient)
- Haiku = UNMET, Gemini = MET: 15 cases
- Gemini 3.1 Pro with `thinking=low` is significantly stricter and more closely follows the DRACO paper methodology

The Haiku-judged score of 0.694 likely overstates performance due to lenient grading. The Gemini 3.1 Pro-judged subsample (0.471) is probably more accurate, placing us well below the ~67% best-system saturation reported in the DRACO paper. The gap suggests concrete areas for improvement in citation accuracy, numerical precision, and adherence to negative constraints.

---

## Judge Configuration

| Benchmark | Judge Model | Temperature | Thinking | Method |
|---|---|---|---|---|
| ResearchRubrics | Gemini 2.5 Pro Preview | default | none | Real-time |
| DRACO (primary) | Gemini 3.1 Pro Preview | 0.2 | low | Batch API |

Judge prompts are exact copies from the respective benchmark repositories to ensure comparability with paper baselines.

---

## Cost and Infrastructure

| Item | Detail |
|---|---|
| Agent model (Z.ai GLM-5.1) | ~$0 estimated (beta) |
| ResearchRubrics judging (10 tasks) | ~$1.50 (Gemini 2.5 Pro, real-time) |
| DRACO judging — Haiku (100 tasks) | ~$2.00 (Claude Haiku 4.5, real-time) |
| DRACO judging — Gemini 3.1 Pro (10 tasks) | ~$3.32 (batch, 50% discount) |
| DRACO judging — Gemini 3.1 Pro (100 tasks, est.) | ~$33 (batch) |
| Full ResearchRubrics judging (101 tasks, est.) | ~$15 (Gemini 2.5 Pro, real-time) |
| Agent runtime (DRACO 100 tasks) | ~18 hours wall-clock |

---

## Key Findings

1. **Competitive on ResearchRubrics** — Our agent matches Gemini and OpenAI deep research products on the 10-task subsample. Full 101-task run needed for confirmation.

2. **Below-par on DRACO** — At ~47% criterion satisfaction (strict judge), we are ~20 points below the paper's best system. DRACO is designed to be hard, and this gap is not surprising for a first evaluation.

3. **Judge sensitivity is real** — A 22-point score swing (0.471 vs 0.694) between judges on the same outputs means judge model choice matters as much as agent quality. The DRACO paper methodology (Gemini with thinking) should be the canonical judge.

4. **Cost is manageable** — Full judging of both benchmarks is under $50 total using Gemini Batch API at 50% discount.

---

## Next Steps

- [ ] Run full 101-task ResearchRubrics evaluation
- [ ] Re-judge all 100 DRACO tasks with Gemini 3.1 Pro (batch)
- [ ] Analyze per-domain DRACO breakdown to identify weak areas
- [ ] Iterate on agent prompts/tools to close the DRACO gap
- [ ] Produce final report with confidence intervals
