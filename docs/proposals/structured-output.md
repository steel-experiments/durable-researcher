# Structured Output for the Durable Researcher

## Context

Markdown reports are great for humans, but production workflows often need
machine-readable output — e.g. filling CRM fields, populating a spreadsheet, or
feeding a downstream pipeline. The ask: support a caller-supplied **JSON-Schema**
and emit a validated JSON object conforming to it, *alongside* the existing
markdown report (the report stays the primary artifact; structured output is
additive).

**Decisions locked in with Niko:**
- **Generation:** forced tool call. We register a one-off `emit_structured_output`
  tool whose parameters *are* the caller's schema, run one constrained LLM turn
  over the finalized report, and validate the tool-call arguments.
- **Validation:** `@sinclair/typebox`, already bundled (transitively) via
  `@mariozechner/pi-ai`. No new direct dependency (honors "minimal deps").
- **Scope (first cut):** core extraction pass + **CLI flag** only. The HTTP API
  surface (`outputSchema` on create-run, `/structured` endpoint, JSON artifact)
  and per-field provenance are **deferred** (see bottom).

## Design

A new **durable extraction step** runs after the markdown report is finalized and
the verify/rewrite loop completes. It is purely additive — if no schema is
requested, nothing changes.

Mechanism (verified against the installed `pi-ai` types):
- `completeSimple(model, { systemPrompt, messages, tools: [emitTool] }, opts)` —
  `Context.tools` is supported and the returned `AssistantMessage.content` can
  contain a `ToolCall { name, arguments }`.
- `emitTool.parameters = Type.Unsafe(userSchema)` wraps the caller's JSON Schema
  as a typebox `TSchema` (`Type` is re-exported from `pi-ai`).
- `validateToolArguments(emitTool, toolCall)` (from `pi-ai`) validates **and
  coerces** the arguments against that schema, throwing on mismatch. This is the
  same helper the agent loop already trusts for tool dispatch.
- **Bounded retry**, mirroring the existing `MAX_REWRITES = 2` verify loop
  (`src/agent.ts:725-890`): on no-tool-call or validation failure, re-prompt once
  more including the validation error text; cap at 2 attempts; on final failure
  record the errors and leave `value: null` rather than throwing (a failed
  extraction must never fail the whole research run).

## New module: `src/structured-output.ts`

ABOUTME comment + the feature's logic, structured for testability following the
repo's injectable-function convention (cf. `ModeClassifier` in `classify.ts:16`,
`GapAnalyzer` in `tools/gap-analysis.ts:17`, `ClaimVerifier` in
`tools/verify-claims.ts:52`).

```ts
export type StructuredOutputResult = {
  schema: Record<string, unknown>;   // echo of the requested schema
  value: unknown | null;             // validated+coerced object, or null on failure
  valid: boolean;
  errors?: string[];                 // validation/parse errors when !valid
};

// Injectable LLM boundary so unit tests never hit a network.
export type StructuredEmitter = (input: {
  report: string;
  notesDigest: string;
  schema: Record<string, unknown>;
  previousErrors?: string[];
}) => Promise<ToolCall | null>;   // returns the emit_structured_output call, or null

export function buildEmitTool(schema: Record<string, unknown>): Tool;        // Type.Unsafe(schema)
export const defaultStructuredEmitter: StructuredEmitter;                    // completeSimple + Context.tools
export async function extractStructuredOutput(input: {
  report: string;
  notes: ResearchNote[];
  schema: Record<string, unknown>;
  emitter?: StructuredEmitter;   // defaults to defaultStructuredEmitter
}): Promise<StructuredOutputResult>;                                         // owns the validate + retry loop
```

- `defaultStructuredEmitter` uses `getUtilityModel()` / `getUtilityReasoning()`
  (`config.ts:41,48`) + `getEnvApiKey` — extraction is mechanical, the hard work
  (the report) is already done. System prompt: "Read the report; call
  `emit_structured_output` with fields grounded ONLY in the report. Leave a field
  null/empty if the report doesn't support it. Do not invent values."
- Validation lives in `extractStructuredOutput` via `validateToolArguments`, so it
  is exercised with the *real* typebox validator in tests (no mock of validation).
- Notes digest reuses the same shape gap-analysis already builds from notes.

## Wiring

1. **`src/types.ts`**
   - `ResearchParams` (line 13): add `outputSchema?: Record<string, unknown>;`
   - `ResearchResult` (line 274): add `structuredOutput?: StructuredOutputResult;`

2. **`src/agent.ts`** — finalization (after the verify/rewrite loop, ~line 895,
   before/at `buildResult`):
   - When `params.outputSchema` is set and a `finalReport` exists, run a durable
     step: `await ctx.step("extract-structured-output", () => extractStructuredOutput({ report, notes, schema: params.outputSchema! }))`.
     Durable so it survives crash/resume exactly like `verify-claims-attempt-N`.
   - Thread the result into `buildResult(...)` (signature gets one optional arg)
     so it lands on the returned `ResearchResult.structuredOutput`.

3. **CLI (`src/cli-args.ts`, `src/index.ts`)**
   - `cli-args.ts`: add `--output-schema` to `FLAGS_WITH_VALUES`; parse into
     `outputSchemaPath?: string`; validate in `validateResearchCliArgs` that the
     path exists and parses as a JSON object (else return an error string).
   - `index.ts`: read+parse the file once near arg handling, set
     `params.outputSchema` on the spawn-new path (`:341`) and the extend paths
     (`:237`, `:314`, `:411`) so structured output works for fresh and extended runs.

4. **Output to disk (`src/report-io.ts`, `src/cli-output.ts`)**
   - `saveResearchResult` (`report-io.ts:52`): when `result.structuredOutput?.value`
     is non-null, also write `${base}.json` (pretty-printed) and return its path on
     `SavedResearchResult` (add `jsonPath?`).
   - `cli-output.ts:31`: print the `.json` path, and if `!valid` print a one-line
     warning with the first error so a failed extraction is visible, not silent.

## Tests (TDD — write first, per project policy)

- **`tests/structured-output.test.ts`** (new): inject a `StructuredEmitter` stub
  returning canned `ToolCall`s.
  - valid object → `valid:true`, schema echoed, value returned;
  - type coercion (e.g. numeric string → number) via real `validateToolArguments`;
  - schema violation → retry, then a second valid emit succeeds;
  - persistent violation → 2 attempts, `valid:false`, `value:null`, `errors` set;
  - emitter returns `null` (model declined to call) → graceful `valid:false`.
- **`tests/cli-args.test.ts`** (extend): `--output-schema path` parses; missing
  file / non-object JSON → validation error.
- **`tests/report-io.test.ts`** (extend): result with `structuredOutput.value`
  writes a `.json`; result without one writes none.
- **`tests/agent.test.ts`** (extend): finalization attaches `structuredOutput`
  when `params.outputSchema` is set, and leaves it `undefined` otherwise (inject a
  stub emitter to avoid network).

## Verification (end-to-end)

1. `bun test` — all new + existing suites green, output pristine.
2. Create a schema file, e.g. `examples/crm-schema.json`:
   `{ "type":"object", "required":["company","funding_stage"],
      "properties":{ "company":{"type":"string"},
        "funding_stage":{"type":"string","enum":["seed","series-a","series-b","later"]},
        "hq_country":{"type":"string"}, "employee_count":{"type":"integer"} } }`
3. `bun run dev "Profile of Steel.dev as a company" --output-schema examples/crm-schema.json --no-tui`
   (requires `bun run db:up` + `db:init`). Confirm:
   - `output/<slug>-<ts>.md` still produced (report unchanged);
   - `output/<slug>-<ts>.json` produced, conforms to the schema, fields grounded
     in the report; CLI prints the json path.
4. Resume mid-run (`--resume <id>`) to confirm the `extract-structured-output`
   step replays from its checkpoint rather than re-calling the LLM.

## Deferred (explicit follow-ups, not in this cut)

- **HTTP API**: `outputSchema` on `CreateResearchRunRequest`
  (`api/schemas.ts`, `api/openapi.ts`), a `final-structured` `application/json`
  artifact via `saveResearchArtifact` in `service/research-executors.ts`, and a
  `GET /v1/research-runs/{id}/structured` endpoint (`api/routes.ts`). The data
  path is already mapped — artifacts support arbitrary `contentType`.
- **Per-field provenance**: attach source URL(s)/excerpt backing each field,
  grounded in verified notes.
