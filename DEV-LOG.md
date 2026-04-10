# Development Log

> This log was constructed by reading session logs from Claude Code and Codex sessions on two machines: the dev machine (sessions stored in `~/.claude/projects/-Users-nikola-dev-durable-researcher/`, macOS) and the eval machine (sessions stored in `~/.claude/projects/-home-agent-durable-researcher[-eval]/` and `~/.codex/sessions/`, Linux). Sessions 1–3 and minor sessions were from the dev machine. Sessions 4–7 were from the eval machine. In total, ~11 sessions and ~5,000+ conversation turns were analyzed.

---

## Session 1 — Foundation (`61b890ac`, 3.1M, ~1,097 lines) — Dev Machine

The project started from scratch with a clear brief: *"Build AI Research Agent with Browser Access — combine Pi AI Agent durable turns with Steel browser sessions."* This session was the initial build-out. The first challenge was infrastructure — getting Postgres running, connecting Absurd, and getting the first research task to execute. There were early struggles with database initialization, API keys not loading from `.env`, and the ZAI endpoint configuration for GLM models.

The first live research run ("quantum error correction advances") revealed immediate UX issues: the agent gave no feedback during long operations, leaving the user staring at a blank terminal unsure if it was stuck. The agent loop mechanics had to be explained — how checkpointing works, how the agent resumes from crashes, how it decides to continue researching vs synthesize.

The session then tackled task management: listing tasks, detecting duplicate topics (exact match + LLM fuzzy matching), resume vs extend vs fresh start. A report-looping bug was found and fixed. The clarification system was added as an optional `--clarify` flag. The session ended with creating the GitHub repo, writing a polished README, and pushing the initial public release.

## Session 2 — Performance & Quality Sprint (`4ae8639e`, 7.9M, ~2,360 lines) — Dev Machine

This was the marathon session — the bulk of the engineering work. It began with competitive research: analyzing HyperBrowser's `hyper-research` (a simple one-shot scrape+synthesize tool, architecturally trivial) and `hyperswarm` (a parallel browser agent orchestrator with fan-out/fan-in). The HyperSwarm analysis directly inspired three features that were then implemented via TDD:

1. **Parallel sub-task prefetch** — fan out all plan sub-queries concurrently with a semaphore and budget cap
2. **Incremental note dedup/ranking** — trigram Jaccard similarity for near-duplicate detection, auto-merge
3. **Graceful timeout** — steering message 60s before deadline, `AbortController` abort, partial report from notes

A quality review pass caught a real bug (confidence data hardcoded to "high"), a timer leak, duplicated summarization code, and several efficiency issues. All were fixed.

Then began the iterative testing cycle — running the same research topic ("how is the web evolving from human interaction to AI agent automation") repeatedly, analyzing each run's output, and fixing problems:

- **Plan generation took 240s** — the ZAI provider was extremely slow. Added 60s timeout with fallback query generation.
- **Prefetch browsed garbage** — WhatsApp, German dictionaries, standing desk companies. This led to building the relevance filter: stopwords, stemming, min 2 keyword matches, URL path scoring, query-aware filtering. Multiple iterations refined this from too loose (browsing junk) to too strict (filtering everything) to balanced.
- **Agent spiraled in search loops** — 17 consecutive searches without browsing. Fixed by updating the system prompt to instruct direct URL browsing for known resources.
- **Report printed twice** — the `Promise.race` timeout didn't abort the agent loop. Fixed with `AbortController`.
- **Resume bug** — consecutive assistant messages caused "Cannot continue from message role: assistant". Fixed by popping in a loop.
- **Cleanup SQL was wrong** — referenced a nonexistent `run_id` column. Fixed.

The session then shifted to configuration and model optimization: externalizing model choices to `.env` vars, enabling reasoning (discovered it was OFF despite the model supporting it), switching all utility calls from `glm-4.7-flashx` to `glm-5.1`, and raising reasoning effort to "high".

GitHub issue #2 was reviewed, commented on with implementation details, and closed.

Next came the concurrency overhaul inspired by the user's pushback on separating gathering from analysis. The interleaved approach was preserved, but made faster:

- **Scout tool** — combined search+browse in one call, saving 1-2 LLM turns per follow-up cycle
- **Browse cache** — Postgres-backed cache for scraped pages, survives crashes
- **Smart summarization** — content ≤4KB returned raw, longer content LLM-summarized
- **Pipelined prefetch** — browses start as each search completes, concurrency raised to 10
- **Configurable timeout** — `MAX_DURATION` env var, default 1200s (20 minutes)

The evaluation harness was then built: adding Google Gemini as a judge model, aligning prompts 1:1 with the ResearchRubrics paper (system prompt, user prompt, JSON response format, no thinking mode, pinned model version), then doing the same for DRACO (extracting the grading prompt from Appendix F.5 of the paper, separate system/user prompts, positive/negative criterion handling, thinking=low, temperature=0.2).

The session added Rich progress bars to both `judge` and `run` commands, benchmark-specific config resolution via `.env` vars, a canary check before full runs, and results stored per judge model. Multiple review passes caught broken test signatures, JSON mode incompatibility with thinking, and deprecated model names.

Finally: Gemini Batch API support (50% cost), cost estimation with confirmation prompt, `-y` flag for non-interactive use, and a rate limiter with fail-fast on consecutive 429 errors — after a real-world test showed 330 out of 383 criteria silently dropped due to rate limits.

## Session 3 — Evaluation & Benchmarking (`d9e081c8`, 1.2M, ~465 lines) — Dev Machine

This session started with researching competing approaches (HuggingFace smolagents), evaluating code execution benefits, and exploring benchmark options (ResearchRubrics, DRACO). It built the evaluation pipeline scaffold, set up dataset downloading from HuggingFace, and tested the full run→judge→score→report pipeline end-to-end. Debugging included `.env` loading issues in the Python eval process, running live eval tasks, and verifying judge output quality.

## Minor Sessions — Dev Machine

- **`7fd49eb7`** (580K, 215 lines) — Skill creator work, copying skills between directories
- **`f7729b75`** (164K, 34 lines) — Brief project understanding + researching `deep-research-mcp` by pminervini
- **`ef29e9d8`** (60K, 42 lines) — Fixing browse cache cleanup crash after task deletion
- **`d6ad83f3`** (40K, 20 lines) — Another cleanup fix for the browse cache

---

## Session 4 — Code Review & First Benchmark Runs (`04fc88ad`, 1.6MB, 696 lines) — Eval Machine

This session ran on the Linux eval machine in the main project directory. It started with a comprehensive code review of the entire codebase — reading all 14 source files and writing `FINDINGS.md` with detailed observations about architecture quality, agent tooling design, and areas for improvement.

The code review led to creating `setup.sh` (one-command eval setup) and updating `README.md` with the full eval section, file tree, and CLI examples. All 10 commits were pushed.

The first live benchmark run followed: **ResearchRubrics 10-task pilot** with standard depth. One task (Plautus/Roman slavery) produced only a 55-byte stub report (timeout/failure). The 9 healthy reports were 9–17KB. Judging with Gemini 2.5 Pro produced **41.8% pass rate** (119/285 criteria met). The failed task was re-run, bringing the final score to **42.3%** (142/306 criteria met across 11 tasks).

A **DRACO 10-task pilot** was also run: **45.0% mean normalized score**. Best task hit 0.692 — competitive with Perplexity on that specific topic. Spread was wide (0.172 to 0.692).

The session concluded with a deep failure pattern analysis: 58–69% of failures were missing specific data/numbers, 37–51% were format/structure non-compliance, 24–40% were missing topic/entity coverage. This analysis directly informed the strategy improvements documented in `IMPROVEMENTS.md`.

Upstream changes from the dev machine were pulled and reviewed: format adaptation, specific deliverables enforcement, reasoning enablement, externalized config, scout tool, browse cache.

## Session 5 — Evaluation Engineering Marathon (`ba418c22`, 4.1MB, 1,897 lines) — Eval Machine

This was the largest session on the eval machine. It picked up where Session 4 left off and drove the evaluation pipeline to production quality.

**Judge pipeline hardening:**
- Added three judge providers: Anthropic (Claude Haiku 4.5), Google Gemini, and Z.ai GLM
- Isolated judge results per model to enable cross-judge comparison
- Added canary check (one test verdict before full run) to catch config errors early
- Fixed Anthropic streaming requirement (non-streaming not supported for that model)
- Fixed JSON mode incompatibility with Gemini thinking mode
- Lowered Anthropic `max_tokens` from 50000 to 4096 for efficiency

**Batch API and cost management:**
- Implemented Gemini Batch API support (50% cost reduction)
- Added cost estimation with confirmation prompt before expensive runs
- Added `-y` flag for non-interactive/batch usage
- Built rate limiter with configurable RPM and fail-fast on consecutive 429 errors
- Fixed batch API JSONL format issues (camelCase field names, snake_case vs camelCase mismatch)
- Improved polling logic for batch job completion

**Full benchmark execution:**
- Ran **ResearchRubrics full 101-task** agent execution (all response files generated)
- Ran **DRACO full 100-task** agent execution (~18 hours wall-clock)
- Judged DRACO 100 tasks with Claude Haiku 4.5 (real-time, ~$2)
- Judged DRACO 10 tasks with Gemini 3.1 Pro (batch API, ~$3.32)
- Attempted Gemini 2.5 Pro batch judging of ResearchRubrics — hit 429 rate limits
- Moved DRACO Haiku verdicts into per-model results directory

**PRELIMINARY-REPORT.md was written** — a comprehensive evaluation report including:
- DRACO normalized scores: **47.1%** (Gemini judge) vs **69.4%** (Haiku judge) — a 22-point judge sensitivity swing
- ResearchRubrics: **0.598 pass rate** (10 tasks, Gemini 2.5 Pro) — within 2 points of Gemini and OpenAI Deep Research
- Per-axis quality breakdown: presentation quality 79.3% (competitive), citation quality 68.6% (solid), breadth/depth 25.6% (critical weakness), factual accuracy 41.8% (below baselines)
- Cross-judge sensitivity analysis confirmed by DRACO paper data
- Cost breakdown: ~$50 total for full evaluation, agent itself free on GLM-5.1 beta

The report was expanded with DRACO paper comparison tables covering all 7 baselines, per-axis scores, per-domain breakdowns, resource usage comparison, and judge sensitivity data.

## Session 6 — Verdict Commit & README Update (`f0207d68`, 406KB, 190 lines) — Eval Machine

Short session focused on persisting evaluation results:
- Committed 120 judge verdict JSONL files (ResearchRubrics + DRACO across multiple judge models)
- Updated eval README with results summary
- Pushed everything to remote

## Session 7 — Strategy Review & Planning (Codex, 892 lines) — Eval Machine

A Codex CLI session (`o3` model) on April 9 that conducted a parallel review of the project:

1. **Full project review** — read entire codebase, produced detailed findings
2. **Fix proposal** — second pass over findings with actionable fix plan
3. **Eval strategy analysis** — deep analysis of eval results, identifying that the system is a "good synthesizer with weak routing into exact lookup, primary-document extraction, and precision answering"
4. **IMPROVEMENTS.md** — wrote comprehensive strategy improvement plan with 8 recommended changes: task classification before planning (lookup/extraction/synthesis modes), hypothesis tracking for ambiguous prompts, primary-source acquisition path, evidence-table generation, tighter completion criteria, conditional output styles
5. **Technical strength analysis** — identified "durable turns" checkpointing pattern as the greatest strength
6. **COST_PLAN.md** — designed future-proof cost accounting system with metering/pricing separation, provider-agnostic usage events, versioned pricing catalog, exact vs estimated confidence model
7. **Eval infrastructure fixes** — fixed GLM judge provider configuration, researched Z.ai rate limits and concurrency
8. **Eval execution guidance** — walked through how to run benchmarks, confirmed DRACO had been executed, discussed remaining eval work

---

## By the Numbers

- **~5,000+ conversation turns** across all sessions (both machines)
- **~17MB** of total session data
- **75 commits** shipped across 5 days (Apr 6–10, 2026)
- **98 TypeScript tests + 67+ Python tests** all passing
- **14 source files created**, ~20 modified
- **2 GitHub issues addressed** (one closed)
- **2 benchmark suites** fully integrated (ResearchRubrics 101 tasks + DRACO 100 tasks) with paper-matched methodology
- **3 judge models** configured (Gemini 2.5 Pro, Gemini 3.1 Pro, Claude Haiku 4.5)
- **218 files changed** in the final evaluation push (response files, verdicts, reports)
- **~$8 spent** on judge API calls so far (~$50 estimated for complete evaluation)
- **~30 hours** total agent execution time (201 research tasks across both benchmarks)
