# Code Review Findings

## Architecture & Design

**Strong foundation.** The "durable turns" pattern — checkpointing every LLM message as an Absurd step in Postgres and replaying on crash — is well-conceived and cleanly implemented. The separation between `durable-turns.ts` (persistence/replay), `agent.ts` (orchestration), and `index.ts` (CLI) is clear.

**Agent tooling design is solid.** The 7-tool set (plan, prefetch, search, browse, screenshot, note, evaluate) follows a natural research workflow. The `prefetch_sources` tool that fans out parallel search+browse is a particularly good idea — it front-loads information gathering instead of plodding through sequential search-browse cycles.

**Good use of steering messages.** The `getSteeringMessages` hook with timeout detection, source/turn limits, and auto-evaluation after N browses is a well-thought-out approach to keeping the agent on track.

## Code Quality

### Positives

- Consistent style, well-organized imports, clear naming
- Handlebars templates for prompts are a good choice — easily editable without touching code
- `ABOUTME` comments at the top of every file provide good orientation
- Pure utility functions (`content.ts`, `notes-ranker.ts`) are testable and side-effect-free
- Error handling is generally pragmatic — LLM fallbacks in `plan.ts` and `browse.ts`, tracking URL unwrapping

### Issues

1. **`index.ts` is too big and does too much** (505 lines). It mixes CLI parsing, DB queries, task management, report saving, and interactive prompts. The `main()` function is ~350 lines with deeply nested conditionals. This is the hardest file to modify safely.

2. **`convertToLlm` is duplicated** — defined identically in `agent.ts:41-47` and `follow-up.ts:21-27`. Should be a shared export.

3. **`(app as any).getLastUsage`** — `agent.ts:442` monkey-patches the Absurd instance with a usage getter via `(app as any)`. This is fragile. A wrapper class or explicit return type would be cleaner.

4. **`cleanupTasks()` runs raw SQL** — `index.ts:126-152` executes three separate `DELETE` queries against the `absurd.*` schema directly. This is tightly coupled to Absurd's internal schema and will break if the schema changes. The same pattern appears in `task-finder.ts` querying `absurd.t_default`.

5. **Mixed concerns in `createLoggingPersister`** — `durable-turns.ts:94-209` is a 115-line function that handles progress logging, usage tracking, report detection, heartbeat calls, AND checkpoint persistence all in one event handler. It's doing too much.

6. **`scrapedUrls` mutated via closure across tools** — The `Set<string>` is shared by reference across `search`, `browse`, `prefetch`, and `evaluate` tools, plus the persister and the agent loop itself. This works but is implicit and hard to reason about. A state object with explicit methods would be safer.

## Testing

**46 pass, 15 fail, 5 errors.** Several test files fail because `steel-sdk` and `@mariozechner/pi-ai` aren't installed (or aren't resolvable in the test environment). The tool tests (`search.test.ts`, `note.test.ts`, `prefetch.test.ts`, `browse.test.ts`) and `agent.test.ts` all error out.

The tests that do work cover:
- `content.ts` utilities — thorough
- `notes-ranker.ts` — comprehensive edge cases
- `durable-turns.ts` state rebuilding — good
- `clarify.ts` question parsing — solid
- `timeout.test.ts` — covers timeout steering and partial reports well

One test failure (`buildResult with partial reports > falls back to partial when last assistant message only has tool calls`) looks like a real bug — the `buildResult` function walks messages backwards looking for assistant text, but the test expects fallback to partial report when the last message only has tool calls.

**Missing test coverage:**
- `task-finder.ts` (DB-dependent, understandable)
- `steel-client.ts` (external API, but URL unwrapping is testable)
- `follow-up.ts`
- The prompt templates
- Integration/e2e tests for the full agent loop

## Security

- **No input sanitization on user topic** — `params.topic` flows directly into Handlebars templates and SQL queries. While Handlebars auto-escapes HTML by default, the topic is also interpolated into LLM prompts and console output.
- **`DATABASE_URL` defaults to hardcoded credentials** (`postgres:postgres@localhost:5432/absurd`) in three places (`agent.ts:163`, `task-finder.ts:16`, `index.ts:118`). Fine for local dev, but `task-finder.ts` opens a new `pg.Pool` on every call without respecting connection limits.
- **No rate limiting on Steel API calls** — `prefetch_sources` fires up to 5 concurrent browse requests + N concurrent search requests. A bug or misconfigured budget could hammer the API.

## Performance

1. **New `pg.Pool` per operation in `task-finder.ts`** — `findRecentTasks()` creates and destroys a pool on every call. In `index.ts`, it's called potentially 3 times (lines 267, 337, 367) in a single run. This wastes connection setup time and can exhaust Postgres connections.

2. **`isBlockedUrl` converts Set to Array every call** — `steel-client.ts:84` does `Array.from(BLOCKED_DOMAINS).some(...)` on every URL check. Since `BLOCKED_DOMAINS` is a `Set`, the `.some()` check should iterate the set directly or use a pre-built trie for domain suffix matching.

3. **`notes-ranker.ts` dedup is O(n^2)** — `findDuplicatePairs` compares every pair of notes. Fine for small note counts, but could slow down on deep research runs with 50+ notes. The iterative merge-one-pair-then-rescan approach in `deduplicateNotes` makes this worse (O(n^2) per iteration, multiple iterations).

4. **Replay rebuilding on every resume** — `rebuildStateFromMessages` walks all messages to reconstruct state. On a long research run with hundreds of messages, this gets expensive. Consider checkpointing a state snapshot periodically.

## Specific Issues

| File | Line | Issue |
|------|------|-------|
| `agent.ts` | 430-434 | `context.messages.pop()` removes the last assistant message on resume if it has tool calls — this silently drops data. A comment explains why, but it's still risky. |
| `agent.ts` | 260 | `getModel("zai", "glm-5.1")` is hardcoded as default. The CLI help says this, but the model name looks like it might change between SDK versions. |
| `browse.ts` | 96 | `summarizeContent` uses `getModel("zai", "glm-4.7-flashx")` — a different model than the main agent. Same in `plan.ts:76` and `task-finder.ts:79`. If this model ID is wrong or unavailable, these features silently fall back to truncated content. |
| `durable-turns.ts` | 154-171 | Usage tracking casts `msg.usage` with a complex inline type union. This is brittle — the Pi Agent SDK's usage type could change. |
| `index.ts` | 402-415 | The `--clarify` flow only runs when `process.stdin.isTTY`, but the `--clarify` flag is silently ignored in non-TTY contexts with no warning. |
| `plan.hbs` | 13 | Hardcodes `2025, 2026` year qualifiers — will need updating. |

## Summary

This is a well-architected agent with a clear durable execution model and thoughtful tooling design. The core pattern is sound. The main areas for improvement are:

1. **Split `index.ts`** into CLI parsing, task management, and report handling modules
2. **Fix failing tests** — the tool tests need proper mocking of `steel-sdk` and `pi-ai`
3. **Extract shared state** from closures into an explicit state object
4. **Consolidate DB access** — use a single pool instead of creating new ones per query
5. **Add the `buildResult` fallback test fix** — appears to be a real bug
