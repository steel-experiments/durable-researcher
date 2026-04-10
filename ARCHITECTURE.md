# Architecture

## System Overview

Durable Researcher is a fault-tolerant deep research agent. Every LLM turn is checkpointed to PostgreSQL so the agent can resume after crashes without losing progress. It uses Steel Cloud for browser automation and a configurable LLM provider for reasoning.

```mermaid
graph TB
    subgraph CLI
        INDEX["index.ts<br/>CLI entry point"]
        BENCH["bench.ts<br/>Eval bridge"]
    end

    subgraph "Agent Core"
        AGENT["agent.ts<br/>Absurd task + agent loop"]
        DT["durable-turns.ts<br/>Checkpoint bridge"]
        PROMPTS["prompts/<br/>Handlebars templates"]
        CONFIG["config.ts<br/>Env-based config"]
    end

    subgraph "Research Tools"
        PLAN["plan_research"]
        PREFETCH["prefetch_sources"]
        SCOUT["scout"]
        SEARCH["web_search"]
        BROWSE["browse_url"]
        SCREENSHOT["screenshot"]
        NOTE["take_note"]
        EVAL["evaluate_progress"]
    end

    subgraph "Infrastructure"
        STEEL["steel-client.ts<br/>Steel SDK wrapper"]
        CACHE["browse-cache.ts<br/>Postgres cache"]
        RANKER["notes-ranker.ts<br/>Dedup + rank"]
    end

    subgraph "External"
        PG[("PostgreSQL<br/>Absurd + browse cache")]
        STEELAPI["Steel Cloud API<br/>Scrape / Screenshot"]
        LLM["LLM Provider<br/>Z.ai GLM-5.1"]
    end

    INDEX --> AGENT
    BENCH --> AGENT
    AGENT --> DT
    AGENT --> PROMPTS
    AGENT --> CONFIG
    AGENT --> PLAN & PREFETCH & SCOUT & SEARCH & BROWSE & SCREENSHOT & NOTE & EVAL

    PLAN --> LLM
    PREFETCH --> STEEL
    SCOUT --> STEEL
    SEARCH --> STEEL
    BROWSE --> STEEL & CACHE
    NOTE --> RANKER
    EVAL --> RANKER

    STEEL --> STEELAPI
    DT --> PG
    CACHE --> PG

    style CLI fill:#1a1a2e,stroke:#e94560,color:#fff
    style "Agent Core" fill:#16213e,stroke:#0f3460,color:#fff
    style "Research Tools" fill:#0f3460,stroke:#533483,color:#fff
    style "Infrastructure" fill:#533483,stroke:#e94560,color:#fff
    style "External" fill:#1a1a2e,stroke:#e94560,color:#fff
```

---

## Durable Turns Pattern

The core innovation. Every LLM message (user, assistant, tool result) is persisted as an Absurd step in PostgreSQL. On crash, the agent replays all checkpointed messages, rebuilds in-memory state (notes, scraped URLs), and continues from the last checkpoint.

```mermaid
sequenceDiagram
    participant User
    participant CLI as index.ts
    participant App as Absurd App
    participant PG as PostgreSQL
    participant Loop as Pi Agent Loop
    participant LLM as LLM Provider

    User->>CLI: bun run src/index.ts "topic"
    CLI->>App: spawn("research", params)
    App->>PG: beginStep("message")
    PG-->>App: { done: false } (fresh run)

    Note over App,LLM: First turn
    App->>Loop: runAgentLoopContinue()
    Loop->>LLM: System prompt + user message
    LLM-->>Loop: Assistant response (tool calls)
    Loop->>App: message_end event
    App->>PG: completeStep({ message })
    App->>PG: beginStep("message") (next slot)

    Note over App,LLM: Tool execution + next turn
    Loop->>Loop: Execute tools (search, browse, note...)
    Loop->>LLM: Tool results + conversation
    LLM-->>Loop: More tool calls or final report

    Note over App,PG: CRASH happens here

    User->>CLI: bun run src/index.ts "topic" (restart)
    CLI->>App: spawn("research", same params)
    App->>PG: beginStep("message")
    PG-->>App: { done: true, state: msg1 }
    App->>PG: beginStep("message")
    PG-->>App: { done: true, state: msg2 }
    App->>PG: beginStep("message")
    PG-->>App: { done: false } (checkpoint reached)

    Note over App: Rebuild state from replayed messages
    App->>App: rebuildStateFromMessages()<br/>→ notes, scrapedUrls
    App->>Loop: Continue from last checkpoint
    Loop->>LLM: Resumed conversation
```

### State Rebuilding

On resume, `rebuildStateFromMessages()` walks the message history to reconstruct:

- **Notes** — from successful `take_note` tool calls + results
- **Scraped URLs** — from successful `browse_url`, `prefetch_sources`, and `scout` results

This means the agent never re-browses pages it already visited and never loses research notes.

---

## Research Tool Flow

The agent uses 8 tools in a structured research workflow. The LLM orchestrates which tools to call and when, guided by the system prompt and steering messages.

```mermaid
flowchart TD
    START([Topic received]) --> PLAN

    subgraph "Phase 1: Planning"
        PLAN["plan_research<br/>Generate sub-queries<br/>via utility LLM"]
    end

    PLAN --> PREFETCH

    subgraph "Phase 2: Parallel Gathering"
        PREFETCH["prefetch_sources<br/>Fan-out search + browse<br/>Concurrency: 10"]
    end

    PREFETCH --> LOOP

    subgraph "Phase 3: Iterative Research"
        LOOP{"Agent decides<br/>next action"}
        LOOP -->|"Targeted search"| SCOUT["scout<br/>Search + browse<br/>in one call"]
        LOOP -->|"Broad search"| SEARCH["web_search<br/>Multi-engine SERP"]
        LOOP -->|"Known URL"| BROWSE["browse_url<br/>Scrape + summarize"]
        LOOP -->|"Visual content"| SCREENSHOT["screenshot<br/>Steel screenshot"]
        LOOP -->|"Record finding"| NOTE["take_note<br/>Structured finding"]
        LOOP -->|"Check coverage"| EVAL["evaluate_progress<br/>Rank notes, gaps"]
        NOTE --> LOOP
        EVAL --> LOOP
        SCOUT --> LOOP
        SEARCH --> LOOP
        BROWSE --> LOOP
        SCREENSHOT --> LOOP
    end

    LOOP -->|"Sufficient coverage<br/>or timeout"| REPORT

    subgraph "Phase 4: Synthesis"
        REPORT["Final report<br/>Written by LLM from<br/>accumulated notes"]
    end

    REPORT --> DONE([Result saved])

    style "Phase 1: Planning" fill:#1a1a2e,stroke:#e94560,color:#fff
    style "Phase 2: Parallel Gathering" fill:#16213e,stroke:#0f3460,color:#fff
    style "Phase 3: Iterative Research" fill:#0f3460,stroke:#533483,color:#fff
    style "Phase 4: Synthesis" fill:#533483,stroke:#e94560,color:#fff
```

### Tool Summary

| Tool | Purpose | External Calls |
|------|---------|---------------|
| `plan_research` | Generate sub-queries via utility LLM | LLM (60s timeout) |
| `prefetch_sources` | Parallel search+browse all sub-queries | Steel (scrape) x N |
| `scout` | Combined search+browse in one call | Steel (scrape) |
| `web_search` | Multi-engine SERP (Bing > DDG > Google) | Steel (scrape) |
| `browse_url` | Scrape page, smart summarize | Steel (scrape), LLM (>4KB), Cache |
| `screenshot` | Capture page screenshot | Steel (screenshot) |
| `take_note` | Record structured finding | None (in-memory) |
| `evaluate_progress` | Show coverage, rank notes, suggest gaps | None (in-memory) |

---

## Steering and Limits

The agent loop has three mechanisms to prevent runaway execution:

```mermaid
flowchart LR
    subgraph "Steering Triggers"
        T["Timeout<br/>(60s before deadline)"]
        S["Source limit<br/>(maxSources reached)"]
        R["Turn limit<br/>(iterations x 15)"]
        A["Auto-eval<br/>(every 5 browses)"]
    end

    T --> MSG["Inject steering message:<br/>Stop tools, write report NOW"]
    S --> MSG
    R --> MSG
    A --> EVAL_MSG["Inject eval data:<br/>notes count, source count, domains"]

    MSG --> LLM["LLM receives<br/>steering message"]
    EVAL_MSG --> LLM

    LLM -->|"Hard limits"| ABORT["AbortController.abort()<br/>+ build partial report from notes"]

    style "Steering Triggers" fill:#1a1a2e,stroke:#e94560,color:#fff
```

- **Timeout steering**: 60s before `MAX_DURATION`, a user message is injected telling the agent to stop and write the report. At the hard deadline, `AbortController.abort()` kills the loop and a partial report is built from accumulated notes.
- **Auto-evaluation**: After every 5 browses without an explicit `evaluate_progress` call, the system injects a status message showing source/turn counts, confidence distribution, and domain diversity.
- **Hard limits**: Source count (`maxSources`, default 20) and turn count (`iterations x 15`) are enforced.

---

## Browse Cache

A PostgreSQL-backed cache prevents re-scraping pages across crashes and task extensions.

```mermaid
flowchart LR
    BROWSE["browse_url called"] --> CHECK{"Cache<br/>hit?"}
    CHECK -->|"Yes"| RETURN["Return cached<br/>RefinedContent"]
    CHECK -->|"No"| SCRAPE["Steel scrape"]
    SCRAPE --> STORE["Store in Postgres<br/>(task_id, url, content)"]
    STORE --> RETURN

    subgraph "Cache lifecycle"
        EXPIRE["7-day expiry<br/>on cleanup"]
        ORPHAN["Orphan cleanup<br/>when task deleted"]
    end

    style "Cache lifecycle" fill:#1a1a2e,stroke:#e94560,color:#fff
```

---

## Content Processing Pipeline

```mermaid
flowchart LR
    URL["URL to browse"] --> STEEL["Steel scrape<br/>(markdown)"]
    STEEL --> CLEAN["Clean content<br/>(whitespace, blank lines)"]
    CLEAN --> VALID{"Meaningful<br/>content?"}
    VALID -->|"No"| REJECT["Reject<br/>(too short/garbage)"]
    VALID -->|"Yes"| SIZE{"Content<br/>length?"}
    SIZE -->|"<= 4KB"| RAW["Return raw"]
    SIZE -->|"> 4KB"| LLM_SUMM["LLM summarize<br/>(500 tokens,<br/>45s timeout)"]
    LLM_SUMM --> RESULT["RefinedContent<br/>(title, url, summary)"]
    RAW --> RESULT

    style RESULT fill:#0f3460,stroke:#533483,color:#fff
```

---

## Note Deduplication and Ranking

Notes are deduplicated using trigram Jaccard similarity and ranked by quality.

```mermaid
flowchart TD
    INPUT["New note added"] --> COUNT{"Notes<br/>count?"}
    COUNT -->|"< 8"| STORE["Store note"]
    COUNT -->|">= 8"| DEDUP["Dedup pass<br/>(trigram Jaccard > 0.6)"]
    DEDUP --> MERGE["Merge near-duplicates<br/>(keep longer)"]
    MERGE --> RANK["Rank by:<br/>1. Confidence (high > med > low)<br/>2. Source count<br/>3. Content length"]
    RANK --> STORE

    style DEDUP fill:#533483,stroke:#e94560,color:#fff
```

---

## Evaluation Pipeline

A separate Python harness benchmarks the agent against academic datasets.

```mermaid
flowchart LR
    subgraph "Stage 1: Download"
        DL["bench download all"] --> HF["HuggingFace<br/>ResearchRubrics (101 tasks)<br/>DRACO (100 tasks)"]
    end

    subgraph "Stage 2: Run Agent"
        RUN["bench run researchrubrics<br/>bench run draco"] --> AGENT_RUN["Spawn agent subprocess<br/>per task<br/>(bun run src/bench.ts)"]
        AGENT_RUN --> REPORTS["responses/{bench}/<br/>{task_id}.md"]
    end

    subgraph "Stage 3: Judge"
        JUDGE["bench judge researchrubrics<br/>bench judge draco"] --> LLM_JUDGE["LLM-as-Judge<br/>(Gemini 2.5 Pro /<br/>Gemini 3.1 Pro /<br/>Claude Haiku 4.5)"]
        LLM_JUDGE --> VERDICTS["results/{bench}/{model}/<br/>{task_id}.jsonl"]
    end

    subgraph "Stage 4: Score"
        SCORE["bench score"] --> CALC["Normalized score<br/>sum(weight*met) / sum(pos_weights)"]
    end

    subgraph "Stage 5: Report"
        REPORT["bench report"] --> MD["Markdown summary<br/>per-section breakdowns"]
    end

    HF --> RUN
    REPORTS --> JUDGE
    VERDICTS --> SCORE
    CALC --> REPORT

    style "Stage 1: Download" fill:#1a1a2e,stroke:#e94560,color:#fff
    style "Stage 2: Run Agent" fill:#16213e,stroke:#0f3460,color:#fff
    style "Stage 3: Judge" fill:#0f3460,stroke:#533483,color:#fff
    style "Stage 4: Score" fill:#533483,stroke:#e94560,color:#fff
    style "Stage 5: Report" fill:#1a1a2e,stroke:#e94560,color:#fff
```

### Judge Providers

```mermaid
flowchart TD
    JUDGE_CLI["bench judge --model X"] --> PROVIDER{"Which<br/>provider?"}

    PROVIDER -->|"gemini-*"| GEMINI["Google Gemini<br/>system_instruction<br/>thinking=low, temp=0.2<br/>(DRACO) / no thinking (RR)"]
    PROVIDER -->|"claude-*"| ANTHROPIC["Anthropic Claude<br/>streaming required<br/>max_tokens=4096"]
    PROVIDER -->|"glm-*"| ZAI["Z.ai GLM<br/>OpenAI-compatible<br/>response_format=json<br/>concurrency=1"]

    GEMINI --> BATCH{"--batch<br/>flag?"}
    BATCH -->|"Yes"| BATCH_API["Gemini Batch API<br/>50% cost reduction<br/>JSONL upload + poll"]
    BATCH -->|"No"| REALTIME["Real-time API"]

    BATCH_API --> VERDICT["Binary MET/UNMET<br/>per criterion"]
    REALTIME --> VERDICT
    ANTHROPIC --> VERDICT
    ZAI --> VERDICT

    VERDICT --> SKIP{"Rate limited<br/>or error?"}
    SKIP -->|"Yes"| RETRY["Skip saving<br/>(retry on next run)"]
    SKIP -->|"No"| SAVE["Save to<br/>results/{bench}/{model}/"]

    style PROVIDER fill:#533483,stroke:#e94560,color:#fff
```

---

## CLI Lifecycle

The full lifecycle of a research task from the user's perspective:

```mermaid
stateDiagram-v2
    [*] --> ParseArgs: bun run src/index.ts "topic"

    ParseArgs --> FindExisting: Check for matching tasks

    FindExisting --> CompletedMatch: Exact match found (completed)
    FindExisting --> InProgressMatch: Similar match found (in-progress)
    FindExisting --> SpawnNew: No match

    CompletedMatch --> ViewReport: User chose [v]iew
    CompletedMatch --> ExtendResearch: User chose [e]xtend
    CompletedMatch --> SpawnNew: User chose [n]ew

    InProgressMatch --> ResumeTask: Auto-resume

    SpawnNew --> Clarify: --clarify flag
    SpawnNew --> StartWorker: No clarification
    Clarify --> StartWorker: Answers captured

    ExtendResearch --> StartWorker: Seeds priorNotes + priorUrls
    ResumeTask --> StartWorker

    StartWorker --> AgentLoop: Worker claims task

    AgentLoop --> Checkpointing: Each message persisted
    Checkpointing --> AgentLoop: Continue research
    AgentLoop --> Completed: Final report produced
    AgentLoop --> Timeout: MAX_DURATION reached
    Timeout --> PartialReport: Build from notes

    Completed --> SaveReport: Write to output/
    PartialReport --> SaveReport

    SaveReport --> FollowUp: Offer Q&A (interactive TTY)
    FollowUp --> [*]
    SaveReport --> [*]: Non-interactive
```

---

## Depth Configuration

| Depth | Iterations | Initial Queries | Max Turns | Use Case |
|-------|-----------|-----------------|-----------|----------|
| `quick` | 1 | 3 | 15 | Fast answers, simple topics |
| `standard` | 3 | 5 | 45 | Balanced research |
| `deep` | 5 | 8 | 75 | Comprehensive deep dives |

All configurable via `--depth` flag and `--max-sources`.

---

## External Dependencies

```mermaid
graph LR
    subgraph "Durable Researcher"
        AGENT[Agent Runtime]
    end

    subgraph "LLM Providers"
        ZAI["Z.ai API<br/>GLM-5.1 (reasoning)<br/>Agent + utility calls"]
        GEMINI_J["Google Gemini<br/>2.5 Pro / 3.1 Pro<br/>Judge only"]
        ANTHROPIC_J["Anthropic<br/>Claude Haiku 4.5<br/>Judge only"]
    end

    subgraph "Browser"
        STEEL["Steel Cloud<br/>Scrape, Screenshot<br/>Multi-engine search"]
    end

    subgraph "Persistence"
        PG["PostgreSQL<br/>Absurd schema<br/>Browse cache"]
    end

    AGENT --> ZAI
    AGENT --> STEEL
    AGENT --> PG

    ZAI -.->|"Eval only"| GEMINI_J
    ZAI -.->|"Eval only"| ANTHROPIC_J

    style "Durable Researcher" fill:#0f3460,stroke:#533483,color:#fff
```

---

## File Map

```
src/
├── index.ts              CLI entry — arg parsing, task lifecycle, follow-up
├── agent.ts              Absurd task registration, agent loop, timeout steering
├── bench.ts              Headless eval bridge (single topic → file)
├── durable-turns.ts      Checkpoint load/persist, state rebuild, progress logging
├── types.ts              Shared types: ResearchParams, ResearchNote, ResearchResult
├── config.ts             Env-based config: model, reasoning, duration
├── content.ts            Text cleaning, truncation, token estimation
├── steel-client.ts       Steel SDK wrapper, multi-engine search, URL unwrapping
├── browse-cache.ts       Postgres-backed scrape cache (7-day expiry)
├── notes-ranker.ts       Trigram dedup (0.6 threshold), quality ranking
├── prompts.ts            Handlebars template loader
├── task-finder.ts        Find existing tasks (exact + LLM fuzzy match)
├── follow-up.ts          Interactive Q&A after research completes
├── clarify.ts            Pre-research scope narrowing
├── tools/
│   ├── plan.ts           plan_research — generate sub-queries
│   ├── prefetch.ts       prefetch_sources — parallel fan-out search+browse
│   ├── scout.ts          scout — combined search+browse in one call
│   ├── search.ts         web_search — multi-engine SERP
│   ├── browse.ts         browse_url — scrape + smart summarize
│   ├── screenshot.ts     screenshot — Steel screenshot capture
│   ├── note.ts           take_note — structured finding
│   └── evaluate.ts       evaluate_progress — coverage check
└── prompts/
    ├── system.hbs        Agent system prompt
    ├── plan.hbs          Research planning prompt
    ├── summarize.hbs     Content summarization prompt
    └── clarify.hbs       Clarification prompt

eval/
├── src/bench/
│   ├── cli.py            Typer CLI — download, run, judge, score, report
│   ├── data.py           Dataset download from HuggingFace
│   ├── runner.py         Agent subprocess execution
│   ├── judge.py          LLM-as-judge (Gemini, Anthropic, Z.ai)
│   ├── score.py          Scoring formulas (normalized, pass rate)
│   └── report.py         Markdown report generation
└── tests/                73 unit tests
```
