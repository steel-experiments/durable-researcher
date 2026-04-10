# Evaluation Harness

Benchmarks durable-researcher against two open-source deep research evaluation suites using an LLM-as-judge. The harness supports Anthropic Claude, Google Gemini, and Z.ai GLM judge models.

| Benchmark | Source | Tasks | Criteria | Measures |
|-----------|--------|-------|----------|----------|
| [ResearchRubrics](https://github.com/scaleai/researchrubrics) | Scale AI | 101 | 2,593 | Factual grounding, reasoning, completeness, clarity |
| [DRACO](https://huggingface.co/datasets/perplexity-ai/draco) | Perplexity | 100 | 3,934 | Factual accuracy, breadth/depth, presentation, citations |

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- A judge API key for the model you use:
  - `ANTHROPIC_API_KEY` for Claude
  - `GEMINI_API_KEY` for Gemini
  - `ZAI_API_KEY` for Z.ai GLM
- A running durable-researcher instance (Postgres + Steel) for the `run` step

## Setup

```bash
cd eval
uv sync --dev
```

## Pipeline

The evaluation runs in five stages. Each stage is resumable — re-running skips completed work.

### 1. Download datasets

```bash
uv run bench download all
```

Downloads ResearchRubrics and DRACO from HuggingFace into `data/`.

### 2. Run the agent

```bash
# Start small to validate the pipeline
uv run bench run researchrubrics --limit 3 --depth quick --project-root ..

# Full benchmark at standard depth
uv run bench run draco --depth standard --project-root ..
```

This calls `bun run src/bench.ts` for each benchmark prompt and writes reports to `responses/{benchmark}/{task_id}.md`. Existing reports are skipped automatically once both the markdown report and its usage sidecar exist.
When usage instrumentation is available, it also writes per-task token sidecars at `responses/{benchmark}/{task_id}.usage.json`.

| Flag | Default | Description |
|------|---------|-------------|
| `--depth` | `quick` | Research depth: `quick`, `standard`, `deep` |
| `--max-sources` | `10` | Max URLs the agent browses per task |
| `--concurrency` | `1` | Parallel agent runs (resource-intensive) |
| `--timeout` | `900` | Per-task timeout in seconds |
| `--limit` | all | Cap the number of tasks to run |
| `--project-root` | `..` | Path to the durable-researcher repo root |

### 3. Judge reports

```bash
uv run bench judge researchrubrics
uv run bench judge draco --concurrency 20
uv run bench judge draco --model glm-5.1 --concurrency 8
```

For each report, every criterion is evaluated independently by the selected judge model with a binary MET/UNMET verdict. Results are stored per-task in `results/{benchmark}/{model}/{task_id}.jsonl` — criteria already judged are skipped on re-run.

| Flag | Default | Description |
|------|---------|-------------|
| `--model` | benchmark-specific default | Judge model for scoring |
| `--concurrency` | `20` | Max concurrent API calls |
| `--limit` | all | Cap the number of tasks to judge |
| `--batch` | `false` | Use Gemini Batch API (Gemini only) |

Notes:
- Batch mode is Gemini-only.
- Z.ai judge models use model-specific API concurrency caps. For example, `glm-5.1` is capped to concurrency `1` and `glm-5` is capped to `2`.
- The harness does not invent a provider RPM limit for Z.ai. `JUDGE_RPM` is an optional manual throttle if you encounter 429s.
- The published Z.ai concurrency page for balance-based API usage is the relevant source for eval judging. The separate GLM Coding subscription limits are for coding-plan usage and are not what this harness uses.

### 4. Compute scores

```bash
uv run bench score researchrubrics
uv run bench score draco
```

Prints a table of per-task scores and the overall mean.

**ResearchRubrics** uses a compliance score: `sum(weight * met) / sum(positive_weights)`.

**DRACO** uses a normalized score: `clamp(sum(weight * met) / sum(positive_weights), 0, 1)` plus a pass rate (fraction of criteria correctly handled, accounting for negative-weight penalty criteria).

### 5. Generate report

```bash
uv run bench report researchrubrics
uv run bench report draco --output results/draco-report.md
```

Produces a markdown summary with aggregate stats, per-section breakdowns (DRACO), resource usage averages when `.usage.json` sidecars exist, and the lowest-scoring tasks for debugging.

## Project Structure

```
eval/
├── pyproject.toml             # uv project config
├── src/bench/
│   ├── cli.py                 # Typer CLI entry point
│   ├── data.py                # Download + parse benchmark datasets
│   ├── judge.py               # LLM-as-judge (Claude, Gemini, Z.ai)
│   ├── runner.py              # Agent subprocess execution
│   ├── score.py               # Scoring formulas
│   └── report.py              # Markdown report generation
├── tests/
│   ├── fixtures/              # Sample data for tests
│   ├── test_data.py           # Dataset loading tests
│   ├── test_judge.py          # Prompt construction + parsing tests
│   ├── test_runner.py         # Subprocess skip/command tests
│   └── test_score.py          # Scoring formula tests
├── data/                      # Downloaded datasets (gitignored)
├── responses/                 # Agent reports + per-task usage sidecars
└── results/                   # Judge verdicts (per benchmark/model)
```

## Tests

```bash
uv run python -m pytest tests/ -v
```

73 unit tests covering scoring math, data parsing, judge prompt construction, verdict parsing, pricing/concurrency helpers, and runner skip logic. No LLM calls in tests.

## Completed Evaluation Runs

Agent: durable-researcher with `zai:glm-5.1` (high reasoning), `depth=quick`, `max-sources=10`.

| Benchmark | Tasks | Judge Model | Mean Score | Pass Rate | Verdicts |
|-----------|-------|-------------|------------|-----------|----------|
| ResearchRubrics | 101 | gemini-2.5-pro | 0.598 | — | 2,593 criteria |
| DRACO | 100 | claude-haiku-4-5-20251001 | 0.694 | — | ~3,934 criteria |
| DRACO | 10 | gemini-3.1-pro-preview | 0.471 | — | ~393 criteria |

Results stored in `results/{benchmark}/{model}/` as per-task JSONL verdict files.

### Reference Scores (from benchmark papers)

**ResearchRubrics** (compliance score):
| System | Score |
|--------|-------|
| Best commercial systems | ~68% |

**DRACO** (normalized score):
| System | Score |
|--------|-------|
| Perplexity Deep Research | 70.5% |
| Gemini Deep Research | 59.0% |
| OpenAI Deep Research (o3) | 52.1% |

## Cost Estimation

| Stage | Cost Driver | Estimate (full run) |
|-------|-------------|---------------------|
| Run agent (201 tasks, quick) | Agent LLM + Steel API | Varies by provider |
| Judge (6,500 criteria) | Judge model API | Printed by `bench judge` for Gemini and supported Z.ai GLM models |
| Score + Report | Local compute | Free |
