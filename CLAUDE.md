# Durable Researcher

Self-hosted deep research agent combining Pi Agent SDK, Absurd durable execution, and Steel browser sessions.

## Tech Stack
- **Runtime**: Bun
- **Language**: TypeScript (ESM)
- **Agent loop**: `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`
- **Durability**: `absurd-sdk` (PostgreSQL-backed task checkpointing)
- **Browser**: `steel-sdk` (Steel Cloud API)
- **Tests**: Vitest

## Project Structure
- `src/types.ts` — shared type definitions
- `src/content.ts` — content processing utilities
- `src/steel-client.ts` — Steel SDK wrapper with multi-engine search
- `src/tools/` — agent tools (plan, search, browse, screenshot, note, evaluate)
- `src/durable-turns.ts` — bridge between Absurd checkpoints and Pi Agent message log
- `src/prompts.ts` — system prompt and sub-prompts
- `src/agent.ts` — Absurd task registration and durable agent loop
- `src/index.ts` — CLI entry point

## Commands
- `bun test` — run tests
- `bun run dev` — run the agent CLI
- `bun run db:up` — start Postgres via Docker
- `bun run db:init` — initialize Absurd schema and default queue

## Architecture
The core pattern is "durable turns": every LLM message is checkpointed as an Absurd step.
On crash/resume, messages replay from Postgres and the agent continues from the last checkpoint.
