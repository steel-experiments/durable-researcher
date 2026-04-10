# Preliminary Evaluation Report — Durable Researcher Agent

**Date**: 2026-04-10 | **Agent Model**: Z.ai GLM-5.1 (high reasoning) | **Status**: Partial — full runs pending

## Summary

We evaluated our durable-researcher agent against two public research-quality benchmarks: **ResearchRubrics** (101 tasks, 2,593 criteria) and **DRACO** (100 tasks, 3,934 criteria across 10 domains). Results show our agent is competitive with established deep-research products on ResearchRubrics, while DRACO reveals significant room for improvement — consistent with the benchmark's difficulty.

**Caveat**: ResearchRubrics results cover only 10 of 101 tasks. DRACO results span all 100 tasks but were judged by two different models, revealing a 22-point score swing. We recommend treating these as directional, not final.

---

## How to Read This Report

All scores use **binary pass/fail grading** — each criterion in a rubric is judged MET or UNMET by an LLM judge. Two metrics are reported:

- **Normalized Score**: Sum of criterion weights for MET criteria, divided by total positive weights. Negative-weight criteria (penalizing errors) subtract from the score. Range 0–100%.
- **Pass Rate**: Simple percentage of criteria passed (MET for positive criteria, UNMET for negative criteria). Range 0–100%.

The normalized score is the primary metric — it rewards getting high-importance criteria right. Pass rate treats all criteria equally. The DRACO paper reports both; ResearchRubrics uses pass rate.

**Judge sensitivity**: The same agent outputs scored by different judge models can produce very different numbers. The DRACO paper tested three judges (Gemini-3-Pro, GPT-5.2, Sonnet-4.5) and found that **rankings were stable across judges but absolute scores varied**. This means our scores should be compared against paper baselines judged by the same model, not across judges.

---

## DRACO — Main Results vs. Paper Baselines

The DRACO paper (Perplexity AI, 2026) evaluated seven deep research systems on 100 expert-curated tasks across 10 domains (Finance, Academic, Medicine, Law, Technology, etc.). The primary judge was Gemini-3-Pro with thinking=low, temperature=0.2 — the same configuration we use.

### Normalized Score (primary metric)

| System | Score (%) | Judge | Tasks |
|---|---|---|---|
| Perplexity Deep Research (Opus 4.6) | **70.5** ± 0.3 | Gemini-3-Pro | 100 |
| Perplexity Deep Research (Opus 4.5) | 67.2 ± 0.3 | Gemini-3-Pro | 100 |
| Claude Opus 4.6 (standard + search) | 59.8 ± 0.3 | Gemini-3-Pro | 100 |
| Gemini Deep Research | 59.0 ± 0.4 | Gemini-3-Pro | 100 |
| OpenAI Deep Research (o3) | 52.1 ± 0.2 | Gemini-3-Pro | 100 |
| OpenAI Deep Research (o4-mini) | 41.9 ± 0.4 | Gemini-3-Pro | 100 |
| Claude Opus 4.5 (standard + search) | 46.7 ± 0.3 | Gemini-3-Pro | 100 |
| **Durable Researcher (ours, Gemini 3.1 Pro judge)** | **47.1** | Gemini-3.1-Pro | 10 |
| **Durable Researcher (ours, Haiku judge)** | **69.4** | Claude Haiku 4.5 | 100 |

> **Interpretation**: Our agent scores ~47% under the strict Gemini 3.1 Pro judge (paper-aligned methodology), placing it between OpenAI o4-mini (41.9%) and Claude Opus 4.5 (46.7%). The Haiku judge scores us at 69.4% — comparable to the top systems — but the DRACO paper's cross-judge comparison shows Haiku/Sonnet judges consistently produce higher absolute scores than Gemini judges (e.g., Sonnet-4.5 scored Perplexity at 75.5% vs Gemini's 70.5%). The 69.4% Haiku score is therefore inflated and not directly comparable to the Gemini-judged paper baselines.

### Pass Rate

| System | Pass Rate (%) | Judge | Tasks |
|---|---|---|---|
| Perplexity Deep Research (Opus 4.6) | **72.8** ± 0.3 | Gemini-3-Pro | 100 |
| Perplexity Deep Research (Opus 4.5) | 70.9 ± 0.6 | Gemini-3-Pro | 100 |
| Claude Opus 4.6 (standard + search) | 63.1 ± 0.2 | Gemini-3-Pro | 100 |
| Gemini Deep Research | 62.7 ± 0.5 | Gemini-3-Pro | 100 |
| OpenAI Deep Research (o3) | 56.9 ± 0.2 | Gemini-3-Pro | 100 |
| OpenAI Deep Research (o4-mini) | 48.0 ± 0.5 | Gemini-3-Pro | 100 |
| Claude Opus 4.5 (standard + search) | 50.2 ± 0.2 | Gemini-3-Pro | 100 |
| **Durable Researcher (ours, Gemini 3.1 Pro judge)** | **50.2** | Gemini-3.1-Pro | 10 |
| **Durable Researcher (ours, Haiku judge)** | **73.0** | Claude Haiku 4.5 | 100 |

### Score by Rubric Axis (Quality Breakdown)

The DRACO paper breaks down performance into four rubric axes. This shows *where* our agent is strong and weak compared to the competition.

| Axis | Perplexity (Opus 4.6) | Gemini DR | Claude Opus 4.6 | OpenAI (o3) | **Ours (Gemini judge, 10 tasks)** | **Ours (Haiku judge, 100 tasks)** |
|---|---|---|---|---|---|---|
| Factual Accuracy | **67.9** | 54.9 | 57.9 | 51.4 | 41.8 | 66.0 |
| Breadth & Depth | **73.1** (4.5) | 59.9 | 57.3 | 51.4 | 25.6 | 78.6 |
| Presentation Quality | **90.3** | 87.1 | 73.8 | 63.2 | 79.3 | 80.1 |
| Citation Quality | **64.6** | 51.5 | 56.2 | 45.8 | 68.6 | 59.1 |

> **Interpretation**: Our agent's **presentation quality** (79.3%) is genuinely competitive — only 8 points behind Gemini Deep Research and above OpenAI o3. **Citation quality** also looks solid (68.6%). The critical weakness is **breadth and depth of analysis** (25.6% under Gemini judge) — the strict judge sees our reports as lacking thoroughness and analytical depth. Factual accuracy (41.8%) is also below all paper baselines. These two axes are the biggest improvement targets.

### Score by Domain

| Domain | Perplexity (Opus 4.6) | Gemini DR | Claude Opus 4.6 | OpenAI (o3) |
|---|---|---|---|---|
| Finance | **71.0** | 49.4 | 48.5 | 42.1 |
| Shopping/Product | **64.7** | 53.8 | 51.9 | 44.7 |
| Academic | **82.8** | 72.7 | 72.0 | 73.5 |
| Technology | **66.6** (4.5) | 56.8 | 53.2 | 46.3 |
| General Knowledge | **70.8** (4.5) | 59.6 | 67.0 | 51.5 |
| UX Design | **62.4** | 50.8 | 54.3 | 51.9 |
| Law | **90.2** | 83.5 | 88.6 | 66.7 |
| Medicine | **80.5** | 58.8 | 72.5 | 65.0 |
| Needle in a Haystack | **68.4** (4.5) | 62.8 | 66.2 | 54.5 |
| Personalized Assistant | **68.5** (4.5) | 61.9 | 55.2 | 49.4 |

*Per-domain breakdown for our agent requires re-judging all 100 tasks with Gemini 3.1 Pro — pending.*

### Resource Usage Comparison

| System | Avg Input Tokens | Avg Output Tokens | Avg Latency |
|---|---|---|---|
| Perplexity Deep Research (Opus 4.6) | 778,711 | 8,807 | 245s (~4 min) |
| Gemini Deep Research | 315,548 | 22,066 | 592s (~10 min) |
| OpenAI Deep Research (o3) | 44,587 | 24,944 | 1,808s (~30 min) |
| Claude Opus 4.6 (standard + search) | 691,338 | 8,143 | 193s (~3 min) |
| **Durable Researcher (GLM-5.1)** | — | — | ~650s (~11 min avg) |

> **Interpretation**: Our agent runs at ~11 min/task, comparable to Gemini Deep Research. The total DRACO run (100 tasks) took ~18 hours wall-clock. Token usage for GLM-5.1 is not yet instrumented.

### Judge Sensitivity (Cross-Judge Comparison from Paper)

The DRACO paper validated that judge choice affects absolute scores but not rankings:

| System | Gemini-3-Pro | GPT-5.2 | Sonnet-4.5 |
|---|---|---|---|
| Perplexity Deep Research (Opus 4.6) | 70.5 | 50.4 | 75.5 |
| Gemini Deep Research | 59.0 | 37.8 | 61.4 |
| Claude Opus 4.6 | 59.8 | 42.7 | 70.1 |
| OpenAI Deep Research (o3) | 52.1 | 31.7 | 49.4 |

> **Interpretation**: GPT-5.2 is the harshest judge (all scores ~20 points lower). Sonnet-4.5 is the most lenient (~5 points higher than Gemini). Our Haiku judge (69.4%) behaves similarly to Sonnet-4.5 in producing inflated scores. This is why the Gemini-judged score of 47.1% is the more reliable number for comparing against paper baselines.

---

## ResearchRubrics — Binary Criterion Pass Rate

| System | Pass Rate | Judge Model | Tasks |
|---|---|---|---|
| Gemini Deep Research | 0.615 | Gemini 2.5 Pro (paper default) | 101 |
| **Durable Researcher (ours)** | **0.598** | Gemini 2.5 Pro (paper default) | 10 |
| OpenAI Deep Research | 0.597 | Gemini 2.5 Pro (paper default) | 101 |
| Perplexity Deep Research | 0.487 | Gemini 2.5 Pro (paper default) | 101 |

*Paper baselines from ResearchRubrics (Scale AI, ICLR 2026) Table 5. Our score is a 10-task subsample. Judge model matches the paper's default (Gemini 2.5 Pro Preview 06-05), making scores directly comparable.*

> **Interpretation**: Our agent scores 0.598 — within 2 points of Gemini Deep Research (0.615) and OpenAI Deep Research (0.597), and well above Perplexity (0.487). This is promising but based on only 10/101 tasks. The full 101-task run (response files already generated) will confirm whether this holds.

---

## Judge Configuration

| Benchmark | Our Judge | Paper's Judge | Temperature | Thinking | Method |
|---|---|---|---|---|---|
| ResearchRubrics | Gemini 2.5 Pro Preview | Gemini 2.5 Pro Preview | default | none | Real-time |
| DRACO (primary) | Gemini 3.1 Pro Preview | Gemini 3 Pro (deprecated → 3.1) | 0.2 | low | Batch API |
| DRACO (secondary) | Claude Haiku 4.5 | — | — | — | Real-time |

Judge prompts are exact copies from the respective benchmark repositories. DRACO used Gemini-3-Pro which is now deprecated; we use the successor Gemini-3.1-Pro with the same config (thinking=low, temp=0.2).

---

## Cost and Infrastructure

| Item | Cost | Method |
|---|---|---|
| Agent model (Z.ai GLM-5.1, 201 tasks) | ~$0 (beta) | — |
| ResearchRubrics judging (10 tasks) | ~$1.50 | Gemini 2.5 Pro, real-time |
| DRACO judging — Haiku (100 tasks) | ~$2.00 | Claude Haiku 4.5, real-time |
| DRACO judging — Gemini 3.1 Pro (10 tasks) | ~$3.32 | Gemini Batch API (50% off) |
| DRACO judging — Gemini 3.1 Pro (100 tasks, est.) | ~$33 | Gemini Batch API (50% off) |
| Full ResearchRubrics judging (101 tasks, est.) | ~$15 | Gemini 2.5 Pro, real-time |
| **Total estimated for complete evaluation** | **~$50** | |

Agent runtime: ~18 hours for DRACO (100 tasks), ~12 hours for ResearchRubrics (101 tasks).

---

## Key Findings

1. **Competitive on ResearchRubrics** — Our agent scores 0.598, matching Gemini and OpenAI deep research on the 10-task subsample. Full 101-task judging is the immediate next step.

2. **DRACO places us in the lower tier** — At 47.1% normalized score (strict, paper-aligned judge), we rank between OpenAI o4-mini (41.9%) and Claude Opus 4.5 (46.7%). The gap to the top (Perplexity at 70.5%) is 23 points. This is expected for a first evaluation against frontier systems.

3. **Presentation quality is a genuine strength** — At 79.3%, we exceed OpenAI o3 (63.2%) and Claude Opus 4.6 (73.8%) on presentation. Our reports look good even when the content has gaps.

4. **Breadth/depth and factual accuracy are the critical gaps** — Breadth (25.6%) and factual accuracy (41.8%) are well below all paper baselines. The agent needs to do deeper research and verify facts more carefully.

5. **Judge sensitivity is significant** — A 22-point swing between Haiku and Gemini judges on the same outputs. The DRACO paper confirms this is normal: cross-judge scores vary by up to 20 points. Always compare scores judged by the same model.

6. **Cost is manageable** — Full evaluation of both benchmarks costs ~$50 in judge API fees, with the agent itself running on free-tier GLM-5.1.

---

## Next Steps

- [ ] Judge full 101-task ResearchRubrics with Gemini 2.5 Pro
- [ ] Re-judge all 100 DRACO tasks with Gemini 3.1 Pro (batch) for paper-aligned scores
- [ ] Analyze per-domain DRACO breakdown to prioritize improvements
- [ ] Improve agent breadth/depth and factual accuracy
- [ ] Produce final report with per-domain analysis and confidence intervals
