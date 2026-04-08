# Durable Researcher

A self-hosted deep research agent that browses the web, takes notes, and writes reports — surviving crashes, rate limits, and API outages by checkpointing every LLM turn to Postgres.

Built on [Pi Agent SDK](https://github.com/badlogic/pi-mono) + [Absurd](https://github.com/earendil-works/absurd) + [Steel](https://github.com/steel-dev/steel-node).

## Quick Start

```bash
# Prerequisites: Docker, Bun

git clone https://github.com/steel-experiments/durable-researcher.git
cd durable-researcher

# One-command setup (installs deps, starts Postgres, initializes schema)
./setup.sh

# Edit .env to add your API keys, then run a research task
bun run dev "quantum error correction advances"
```

Or do it manually:

```bash
bun install
docker compose up -d     # Start Postgres
bun run db:init          # Initialize Absurd schema + default queue
ZAI_API_KEY=... STEEL_API_KEY=... bun run dev "quantum error correction advances"
```

## How It Works

```
You → CLI → Absurd task (Postgres) → Pi Agent loop (glm-5.1)
                                          ↓
                              plan → search → browse → note → evaluate → report
                                       ↑        ↑
                                    Bing/DDG   Steel Cloud
                                    (fallback)  (scrape + summarize)
```

The agent follows a **plan → prefetch → note → evaluate → follow-up → report** cycle:

1. **Plan** — Decomposes your topic into targeted sub-queries
2. **Prefetch** — Fans out all sub-queries in parallel: concurrent search + browse with relevance filtering
3. **Note** — Records structured findings with source attribution and auto-deduplication
4. **Evaluate** — Assesses coverage gaps with quality-ranked notes
5. **Follow-up** — Targeted search + browse for gaps, or direct browsing of known URLs
6. **Report** — Writes a sourced, analytical report (format adapts to user instructions)

Every message is checkpointed to Postgres via Absurd. Kill the process mid-run, restart, and it picks up exactly where it left off. Reports are saved to `output/` automatically.

## CLI

```bash
# Basic research
bun run dev "impact of AI on journalism"

# Control depth: quick (1 iteration), standard (3), deep (5)
bun run dev "Rust vs Go for microservices" --depth deep

# Ask clarifying questions before researching
bun run dev "AI safety" --clarify

# Use a different model
bun run dev "AI safety" --model anthropic:claude-sonnet-4-6

# Limit sources
bun run dev "quantum computing" --max-sources 10
```

### Working with existing research

When you run a topic that already has completed research, you're prompted to choose:

```
Found completed research on this topic:
  019d6494-...  "quantum error correction advances" [completed] (30m ago)

What would you like to do?
  [v] View existing report
  [e] Extend research with more sources
  [n] Start fresh research

Choice (v/e/n):
```

Or use flags to skip the prompt:

```bash
bun run dev "quantum error correction" --view      # view existing report + follow-up mode
bun run dev "quantum error correction" --extend    # extend with more sources
bun run dev "quantum error correction" --new       # start fresh
```

**Extend mode** seeds the new task with all prior notes and visited URLs. The agent focuses on gaps, newer developments, and low-confidence areas without re-browsing pages it already visited.

After any report, you enter **follow-up mode** where you can ask questions about the findings:

```
================================================================================
FOLLOW-UP MODE — ask questions about the research (type 'exit' to quit)
================================================================================

> What are the main differences between surface codes and qLDPC codes?
```

### Task management

```bash
bun run dev --list                          # list recent research tasks
bun run dev --resume <task-id>              # resume a specific task
bun run dev --cleanup                       # remove completed/failed tasks
```

In-progress tasks with the same or similar topic are auto-detected and resumed. Similarity matching uses an LLM to catch differently-worded queries on the same subject.

## Configuration

Copy `.env.example` to `.env` or export directly — shell env vars take precedence over `.env`.

| Variable | Required | Description |
|---|---|---|
| `ZAI_API_KEY` | Yes | Z.AI API key for GLM models |
| `STEEL_API_KEY` | Yes | Steel Cloud API key |
| `ANTHROPIC_API_KEY` | Eval only | Anthropic API key for the LLM judge |
| `DATABASE_URL` | No | Postgres connection (default: `postgresql://postgres:postgres@localhost:5432/absurd`) |
| `AGENT_MODEL` | No | Agent model (default: `zai:glm-5.1`) |
| `AGENT_REASONING` | No | Agent reasoning effort (default: `high`) |
| `UTILITY_MODEL` | No | Utility model (default: `zai:glm-5.1`) |
| `UTILITY_REASONING` | No | Utility reasoning effort (default: off) |

## Architecture

```
src/
├── agent.ts           # Absurd task registration + durable agent loop
├── bench.ts           # Headless CLI bridge for benchmarking
├── durable-turns.ts   # Checkpoint bridge: Absurd steps ↔ Pi Agent messages
├── steel-client.ts    # Steel SDK wrapper, multi-engine search, SERP extraction
├── task-finder.ts     # Task deduplication (exact + LLM fuzzy match)
├── clarify.ts         # Pre-research clarification questions via LLM
├── follow-up.ts       # Interactive follow-up questions after report
├── notes-ranker.ts    # Trigram similarity dedup + confidence ranking
├── content.ts         # Text cleaning, truncation, quality checks
├── prompts.ts         # Handlebars template loader
├── index.ts           # CLI entry point
└── tools/
    ├── plan.ts        # Generate sub-queries + search strategy
    ├── prefetch.ts    # Parallel search+browse fan-out for plan sub-queries
    ├── search.ts      # Web search with relevance filtering
    ├── browse.ts      # Scrape + LLM-summarize pages
    ├── screenshot.ts  # Capture page screenshots
    ├── note.ts        # Record structured findings with auto-dedup
    └── evaluate.ts    # Assess research coverage

prompts/
├── system.hbs         # Main agent system prompt
├── plan.hbs           # Research planning prompt
├── summarize.hbs      # Page summarization prompt
└── clarify.hbs        # Clarification question generation prompt
```

### Durable Turns Pattern

The core innovation: every `message_end` event from the Pi Agent loop is persisted as an Absurd step checkpoint. On resume:

1. `loadMessageLog()` replays all checkpointed messages from Postgres
2. `rebuildStateFromMessages()` reconstructs notes + URL dedup set from replayed tool calls
3. `runAgentLoopContinue()` feeds the full conversation back to the LLM — it continues seamlessly

The LLM doesn't know it crashed. The conversation transcript IS the state.

### Hard Limits & Graceful Timeout

The agent enforces hard stops via steering messages injected into the conversation:

| Limit | Standard depth | Trigger |
|---|---|---|
| Max sources | 20 | Browsed URL count |
| Max turns | 45 | Assistant message count |
| Task timeout | 600s | Wall-clock time (60s warning buffer) |

When a limit is hit, the agent is told to stop researching and write its report immediately. On timeout, the agent loop is aborted via `AbortController` and a partial report is built from accumulated notes.

### Parallel Prefetch

After planning, the `prefetch_sources` tool fans out all sub-queries concurrently:

- Searches all queries in parallel via Steel
- Browses top 2 results per query with a semaphore (max 5 concurrent)
- Budget capped at `maxSources / 2` to leave room for targeted follow-ups
- Results filtered by relevance scoring before browsing

### Search Result Relevance Filtering

Search results are scored against both the research topic and the specific query using keyword matching with basic stemming. Results must match at least 2 topic keywords to pass. This prevents browsing irrelevant pages (dictionaries, product sites, unrelated content). The agent is also instructed to browse known URLs directly when search results are poor.

### Note Deduplication & Ranking

Notes are automatically deduplicated using trigram Jaccard similarity (threshold 0.6). Near-duplicate notes are merged: longer content is kept, source URLs are unioned, and higher confidence is preserved. The evaluate tool displays notes in quality-ranked order (confidence → source count → content length).

## Models

All LLM calls use glm-5.1 by default, configurable via environment variables:

| Role | Env Variable | Default | Description |
|---|---|---|---|
| Agent loop | `AGENT_MODEL` | `zai:glm-5.1` | Main research agent + follow-up |
| Agent reasoning | `AGENT_REASONING` | `high` | Thinking effort: minimal, low, medium, high, xhigh |
| Utility calls | `UTILITY_MODEL` | `zai:glm-5.1` | Summarization, planning, matching, clarification |
| Utility reasoning | `UTILITY_REASONING` | *(off)* | Reasoning effort for utility calls |

The `--model` CLI flag overrides `AGENT_MODEL`. Token usage is tracked per-model and printed at the end of each run.

## Development

```bash
bun test              # Run tests
bun run typecheck     # TypeScript check
bun run db:up         # Start Postgres
bun run db:init       # Initialize Absurd schema (idempotent)
./setup.sh            # Full setup: deps, Postgres, schema, eval
```

## Evaluation

Benchmark against [ResearchRubrics](https://github.com/scaleai/researchrubrics) (101 tasks, 2,593 criteria) and [DRACO](https://huggingface.co/datasets/perplexity-ai/draco) (100 tasks, 3,934 criteria) using Claude as LLM-as-judge.

```bash
cd eval
uv sync --dev                         # Install eval dependencies

uv run bench download all             # Download datasets from HuggingFace
uv run bench run researchrubrics --limit 3 --depth quick --project-root ..
uv run bench judge researchrubrics    # Judge reports with Claude
uv run bench score researchrubrics    # Compute scores
uv run bench report researchrubrics   # Generate summary report
```

Each stage is resumable — re-running skips completed work. See [`eval/README.md`](eval/README.md) for full details.

## License

MIT
