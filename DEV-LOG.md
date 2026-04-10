# Development Log

> This log was constructed by reading session logs from Claude Code coding agent sessions stored in `~/.claude/projects/-Users-nikola-dev-durable-researcher/`. Seven sessions totaling ~12.5MB and ~4,000 conversation turns were analyzed to reconstruct the narrative of how this project was built.

---

## Session 1 — Foundation (`61b890ac`, 3.1M, ~1,097 lines)

The project started from scratch with a clear brief: *"Build AI Research Agent with Browser Access — combine Pi AI Agent durable turns with Steel browser sessions."* This session was the initial build-out. The first challenge was infrastructure — getting Postgres running, connecting Absurd, and getting the first research task to execute. There were early struggles with database initialization, API keys not loading from `.env`, and the ZAI endpoint configuration for GLM models.

The first live research run ("quantum error correction advances") revealed immediate UX issues: the agent gave no feedback during long operations, leaving the user staring at a blank terminal unsure if it was stuck. The agent loop mechanics had to be explained — how checkpointing works, how the agent resumes from crashes, how it decides to continue researching vs synthesize.

The session then tackled task management: listing tasks, detecting duplicate topics (exact match + LLM fuzzy matching), resume vs extend vs fresh start. A report-looping bug was found and fixed. The clarification system was added as an optional `--clarify` flag. The session ended with creating the GitHub repo, writing a polished README, and pushing the initial public release.

## Session 2 — Performance & Quality Sprint (`4ae8639e`, 7.9M, ~2,360 lines)

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

## Session 3 — Evaluation & Benchmarking (`d9e081c8`, 1.2M, ~465 lines)

This session started with researching competing approaches (HuggingFace smolagents), evaluating code execution benefits, and exploring benchmark options (ResearchRubrics, DRACO). It built the evaluation pipeline scaffold, set up dataset downloading from HuggingFace, and tested the full run→judge→score→report pipeline end-to-end. Debugging included `.env` loading issues in the Python eval process, running live eval tasks, and verifying judge output quality.

## Minor Sessions

- **`7fd49eb7`** (580K, 215 lines) — Skill creator work, copying skills between directories
- **`f7729b75`** (164K, 34 lines) — Brief project understanding + researching `deep-research-mcp` by pminervini
- **`ef29e9d8`** (60K, 42 lines) — Fixing browse cache cleanup crash after task deletion
- **`d6ad83f3`** (40K, 20 lines) — Another cleanup fix for the browse cache

## By the Numbers

- **~4,000 conversation turns** across all sessions
- **~12.5MB** of session data
- **~70 commits** shipped
- **98 TypeScript tests + 67 Python tests** all passing
- **14 source files created**, ~20 modified
- **2 GitHub issues addressed** (one closed)
- **2 benchmark suites** fully integrated (ResearchRubrics + DRACO) with paper-matched methodology
