# Proposal: Evidence Bundles and Provenance for Durable Researcher

## Summary

Durable Researcher should add a first-class evidence and provenance layer.

Today the project already does a lot of the hard work: it browses sources, caches content, records notes with source URLs and excerpts, verifies claims against citations, persists campaigns, and compiles final reports. The next step is to make that evidence usable as structured data, not only as report text.

This proposal adds a generally useful feature:

> Every research run can produce a portable, deterministic evidence bundle that records what sources were used, when they were captured, what facts were extracted, how claims map to evidence, what verification passed or failed, and what uncertainty remains.

This is useful for normal Durable Researcher users, not only external protocols:

- Reports become more auditable.
- Follow-up questions can inspect source provenance.
- Evals can score evidence quality directly.
- Dashboards can render evidence graphs without parsing markdown.
- Teams can export source trails for compliance, research review, grants, procurement, journalism, diligence, and accountability workflows.
- Future API consumers get stable JSON artifacts instead of scraping prose reports.

The feature should be implemented as a generic Durable Researcher capability. Downstream projects can depend on it, but the core value belongs in Durable Researcher.

---

## Problem

Durable Researcher currently treats source-backed research primarily as a report-generation workflow.

The system persists:

- Durable LLM turns through Absurd.
- Browse cache entries.
- Research notes.
- Source URLs.
- Key excerpts.
- Verification checkpoints.
- Campaign pulses, reports, notes, sources, scores, and artifacts.

But the evidence model is still incomplete for robust external use:

1. Source provenance is not captured deeply enough.
2. Raw, cleaned, summarized, and extracted forms are not tracked as separate evidence states.
3. Source hashes are not part of the core data model.
4. Report claims are verified, but there is no canonical claim-to-rule or claim-to-evidence object.
5. Evidence artifacts are not exported as deterministic JSON with stable IDs and hashes.
6. Downstream consumers must infer structure from markdown reports, notes, and cache rows.

Markdown reports are good for humans.

Evidence bundles are needed for auditability, automation, evaluation, and reuse.

---

## Goals

Add a provenance-native evidence layer that can be used by the CLI, campaigns, tests, dashboards, and external libraries.

Primary goals:

- Capture source provenance when content is fetched.
- Record hashes for raw and transformed source material.
- Represent extracted facts as structured objects.
- Link claims, facts, excerpts, and sources with stable IDs.
- Export deterministic evidence bundles as JSON.
- Keep existing report generation intact.
- Keep the feature useful even when no external integration exists.

Secondary goals:

- Make citation verification easier to inspect.
- Improve campaign finalization quality.
- Support future UI views such as evidence tables, timelines, and claim graphs.
- Support evals that grade evidence quality, not just final answer quality.
- Create a stable library surface for programmatic consumers.

Non-goals for the first implementation:

- Blockchain integration.
- Staking, slashing, or dispute mechanics.
- Cryptographic signing with wallets.
- Permanent storage uploads.
- Full WARC archival.
- Replacing reports with JSON-only output.

---

## Design Principles

### Evidence First, Report Second

The report should be a presentation of the evidence model, not the only place where evidence relationships exist.

### Provenance Is a Chain

A source should not just be a URL. The system should know:

- where it came from,
- when it was captured,
- which adapter captured it,
- what raw content was observed,
- how it was cleaned,
- what excerpts were extracted,
- what claims it supports,
- and what verification happened later.

### Deterministic Artifacts

Evidence bundles should be stable enough to diff, cache, test, and verify.

Use canonical JSON and stable hash functions so repeated exports from the same stored data produce the same roots.

### Keep the CLI Simple

The default CLI experience should remain report-oriented. Evidence output can be opt-in:

```bash
bun run dev "topic" --evidence
bun run dev campaign --finalize <campaign-id> --evidence
```

### Do Not Overfit to One Use Case

The feature should support many research workflows:

- literature surveys,
- extraction tasks,
- diligence,
- public-record research,
- product comparisons,
- grant verification,
- policy tracking,
- audit trails,
- factual claim resolution.

---

## Proposed Data Model

Add these types to `src/types.ts` or a new `src/evidence/types.ts`.

### EvidenceBundle

```ts
export type EvidenceBundle = {
  schemaVersion: "evidence-bundle/v1";
  bundleId: string;
  createdAt: string;
  topic: string;
  taskId?: string;
  campaignId?: string;
  mode: TaskMode;
  bundleHash: string;
  sourceManifestHash: string;
  evidenceGraphHash: string;
  sources: SourceSnapshot[];
  excerpts: EvidenceExcerptRecord[];
  facts: ExtractedFact[];
  claims: EvidenceClaim[];
  reasoning: EvidenceReasoningStep[];
  uncertainties: EvidenceUncertainty[];
  verification?: VerificationSnapshot;
  provenance: ProvenanceEvent[];
  artifacts: EvidenceArtifactRef[];
};
```

### SourceSnapshot

```ts
export type SourceSnapshot = {
  id: string;
  url: string;
  canonicalUrl?: string;
  title?: string;
  sourceType: SourceType;
  capturedAt: string;
  capturedBy: CaptureActor;
  adapter: SourceAdapterRef;
  fetch: FetchMetadata;
  raw: ContentObjectRef;
  cleaned?: ContentObjectRef;
  summary?: ContentObjectRef;
  screenshot?: ArtifactPointer;
  cacheKey?: string;
};
```

### SourceType

```ts
export type SourceType =
  | "webpage"
  | "pdf"
  | "public_record"
  | "filing"
  | "dataset"
  | "api_response"
  | "github"
  | "academic_paper"
  | "news"
  | "official_source"
  | "unknown";
```

### CaptureActor

```ts
export type CaptureActor = {
  kind: "agent" | "user" | "system";
  id?: string;
  label?: string;
};
```

### SourceAdapterRef

```ts
export type SourceAdapterRef = {
  name: string;
  version?: string;
  runtime?: string;
};
```

### FetchMetadata

```ts
export type FetchMetadata = {
  method?: string;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  retrievedAt: string;
  rawLength?: number;
  error?: string;
};
```

### ContentObjectRef

```ts
export type ContentObjectRef = {
  mediaType: string;
  byteLength?: number;
  charLength?: number;
  sha256: string;
  storage?: ArtifactPointer;
};
```

### ArtifactPointer

```ts
export type ArtifactPointer = {
  kind: "local" | "url" | "cache" | "s3" | "ipfs" | "other";
  uri: string;
  sha256?: string;
};
```

### EvidenceExcerptRecord

This should extend the existing `EvidenceExcerpt` concept with source and hash data.

```ts
export type EvidenceExcerptRecord = {
  id: string;
  sourceId: string;
  text: string;
  sha256: string;
  byteRange?: [number, number];
  charRange?: [number, number];
  extractedAt: string;
  extractionMethod: "key_excerpts" | "paragraph_fallback" | "llm" | "parser" | "manual";
};
```

### ExtractedFact

```ts
export type ExtractedFact = {
  id: string;
  text: string;
  normalizedText?: string;
  sourceIds: string[];
  excerptIds: string[];
  confidence: "high" | "medium" | "low";
  extractedAt: string;
  extractedBy: CaptureActor;
};
```

### EvidenceClaim

```ts
export type EvidenceClaim = {
  id: string;
  text: string;
  sourceIds: string[];
  excerptIds: string[];
  factIds: string[];
  confidence: "high" | "medium" | "low";
  verification?: {
    supported: boolean;
    reason: string;
    verifier?: string;
  };
};
```

### EvidenceReasoningStep

```ts
export type EvidenceReasoningStep = {
  id: string;
  title: string;
  content: string;
  claimIds: string[];
  factIds: string[];
  sourceIds: string[];
};
```

### EvidenceUncertainty

```ts
export type EvidenceUncertainty = {
  id: string;
  description: string;
  severity: "low" | "medium" | "high";
  claimIds: string[];
  factIds: string[];
  sourceIds: string[];
};
```

### ProvenanceEvent

```ts
export type ProvenanceEvent = {
  id: string;
  type:
    | "source_discovered"
    | "source_fetched"
    | "content_cleaned"
    | "content_summarized"
    | "excerpt_extracted"
    | "note_recorded"
    | "claim_verified"
    | "report_generated"
    | "bundle_exported";
  at: string;
  actor: CaptureActor;
  inputIds: string[];
  outputIds: string[];
  metadata?: Record<string, unknown>;
};
```

### EvidenceArtifactRef

```ts
export type EvidenceArtifactRef = {
  id: string;
  kind: "report" | "screenshot" | "cache_entry" | "verification" | "campaign_final_report";
  title?: string;
  pointer?: ArtifactPointer;
  sha256?: string;
};
```

---

## Storage Changes

The existing `browse_cache` should remain an optimization. Add dedicated evidence tables for audit data.

### `source_snapshots`

```sql
CREATE TABLE IF NOT EXISTS source_snapshots (
  id text PRIMARY KEY,
  task_id text,
  campaign_id text,
  url text NOT NULL,
  canonical_url text,
  title text,
  source_type text NOT NULL,
  captured_at timestamptz NOT NULL,
  captured_by jsonb NOT NULL,
  adapter jsonb NOT NULL,
  fetch jsonb NOT NULL,
  raw jsonb NOT NULL,
  cleaned jsonb,
  summary jsonb,
  screenshot jsonb,
  cache_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### `evidence_excerpts`

```sql
CREATE TABLE IF NOT EXISTS evidence_excerpts (
  id text PRIMARY KEY,
  source_snapshot_id text NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  text text NOT NULL,
  sha256 text NOT NULL,
  byte_range jsonb,
  char_range jsonb,
  extracted_at timestamptz NOT NULL,
  extraction_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### `provenance_events`

```sql
CREATE TABLE IF NOT EXISTS provenance_events (
  id text PRIMARY KEY,
  task_id text,
  campaign_id text,
  type text NOT NULL,
  at timestamptz NOT NULL,
  actor jsonb NOT NULL,
  input_ids text[] NOT NULL DEFAULT '{}',
  output_ids text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### `evidence_bundles`

```sql
CREATE TABLE IF NOT EXISTS evidence_bundles (
  id text PRIMARY KEY,
  task_id text,
  campaign_id text,
  schema_version text NOT NULL,
  topic text NOT NULL,
  bundle_hash text NOT NULL,
  source_manifest_hash text NOT NULL,
  evidence_graph_hash text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Optional later tables:

- `extracted_facts`
- `evidence_claims`
- `evidence_reasoning_steps`
- `evidence_uncertainties`

For v1, these can live inside `evidence_bundles.content` and be normalized later if query needs justify it.

---

## Hashing and Canonicalization

Add `src/evidence/hash.ts`.

Required functions:

```ts
export function sha256Text(input: string): string;
export function sha256Bytes(input: Uint8Array): string;
export function canonicalJson(value: unknown): string;
export function hashJson(value: unknown): string;
export function stableId(prefix: string, value: unknown): string;
```

Rules:

- JSON object keys must be sorted.
- Undefined fields should be omitted.
- Dates should be ISO strings.
- Hashes should include a prefix such as `sha256:`.
- Bundle hash should exclude `bundleHash` itself.

This gives Durable Researcher stable artifacts that can be tested, cached, diffed, and trusted by downstream systems.

---

## Source Capture Changes

Update the browse pipeline so each fetch can produce a `SourceSnapshot`.

Current path:

```text
browse_url -> fetch/scrape -> clean -> summarize -> cache -> return text
```

Proposed path:

```text
browse_url
  -> fetch/scrape
  -> hash raw content
  -> clean content
  -> hash cleaned content
  -> summarize if needed
  -> hash summary
  -> cache content
  -> store SourceSnapshot
  -> extract excerpts
  -> store EvidenceExcerptRecord
  -> store provenance events
  -> return text to agent
```

This should be implemented without forcing every caller to care about evidence storage. Add optional `evidenceRecorder` parameters to low-level functions.

Example:

```ts
export async function browseOne(opts: {
  client: Steel;
  url: string;
  topic: string;
  scrapedUrls: Set<string>;
  focus?: string;
  taskId?: string;
  campaignId?: string;
  urlExcerpts?: UrlExcerptStore;
  referenceQueue?: ReferenceQueue;
  evidenceRecorder?: EvidenceRecorder;
}): Promise<BrowseOneResult>
```

---

## Evidence Recorder API

Add `src/evidence/recorder.ts`.

```ts
export type EvidenceRecorder = {
  recordSourceSnapshot(snapshot: SourceSnapshot): Promise<void>;
  recordExcerpt(excerpt: EvidenceExcerptRecord): Promise<void>;
  recordProvenance(event: ProvenanceEvent): Promise<void>;
};
```

Provide implementations:

```ts
export function createNoopEvidenceRecorder(): EvidenceRecorder;
export function createPostgresEvidenceRecorder(opts: {
  taskId?: string;
  campaignId?: string;
}): EvidenceRecorder;
export function createMemoryEvidenceRecorder(): EvidenceRecorder;
```

The no-op recorder lets existing tests and code paths continue without storage requirements.

---

## Evidence Bundle Builder

Add `src/evidence/bundle.ts`.

Primary API:

```ts
export async function buildEvidenceBundle(input: {
  result: ResearchResult;
  taskId?: string;
  campaignId?: string;
  topic?: string;
  includeMessages?: boolean;
}): Promise<EvidenceBundle>;
```

Campaign API:

```ts
export async function buildCampaignEvidenceBundle(input: {
  campaignId: string;
  includePulseReports?: boolean;
}): Promise<EvidenceBundle>;
```

The bundle builder should:

1. Load source snapshots for the task or campaign.
2. Load evidence excerpts.
3. Load provenance events.
4. Convert `ResearchResult.explanation.evidence` into facts.
5. Convert `ResearchResult.explanation.claims` into claims.
6. Attach verification data.
7. Attach uncertainty data.
8. Compute `sourceManifestHash`.
9. Compute `evidenceGraphHash`.
10. Compute final `bundleHash`.

In v1, if source snapshots are missing, the builder can fall back to `ResearchResult.sources`, notes, and excerpts.

This backward-compatible fallback is important because older runs should still be exportable.

---

## CLI Changes

Add evidence export flags.

### Single Research Run

```bash
bun run dev "research topic" --evidence
```

Expected behavior:

- Run research as usual.
- Save markdown report as usual.
- Save evidence bundle next to the report:

```text
output/my-topic-2026-05-27.md
output/my-topic-2026-05-27.evidence.json
```

### Existing Task

```bash
bun run dev --export-evidence <task-id>
```

### Campaign

```bash
bun run dev campaign --finalize <campaign-id> --evidence
bun run dev campaign --export-evidence <campaign-id>
```

### Inspection

```bash
bun run dev --show-evidence <task-id>
```

This should print a compact summary:

```text
Evidence bundle: sha256:...
Sources: 18
Excerpts: 42
Claims: 23
Verified claims: 19/23
Unsupported claims: 4
Uncertainties: 3
```

---

## Library/API Changes

Add `src/lib.ts`.

The project currently has many API-shaped internals, but no public package entrypoint. Add one.

```ts
export type {
  ResearchParams,
  ResearchResult,
  CampaignParams,
  CampaignRecord,
  CampaignPulse,
  EvidenceBundle,
  SourceSnapshot,
  ExtractedFact,
  EvidenceClaim,
  ProvenanceEvent,
} from "./types.js";

export {
  createResearchApp,
  buildResult,
} from "./agent.js";

export {
  createCampaign,
  getCampaign,
  listCampaigns,
  listCampaignPulses,
  runCampaign,
  finalizeCampaign,
} from "./campaign.js";

export {
  buildEvidenceBundle,
  buildCampaignEvidenceBundle,
} from "./evidence/bundle.js";
```

Update `package.json`:

```json
{
  "main": "./dist/lib.js",
  "types": "./dist/lib.d.ts",
  "exports": {
    ".": {
      "types": "./dist/lib.d.ts",
      "import": "./dist/lib.js"
    },
    "./cli": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "bin": {
    "durable-researcher": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "bun run typecheck && bun run test && bun run build"
  },
  "files": [
    "dist",
    "prompts",
    "README.md"
  ]
}
```

This makes Durable Researcher usable as a dependency without shelling out to the CLI.

---

## Integration With Existing Explanation Model

The existing `ExplanationModel` is a strong starting point. It already has:

- answer,
- claims,
- evidence,
- excerpts,
- sources,
- reasoning steps,
- uncertainties,
- recommended views.

The evidence bundle should reuse this instead of duplicating logic.

Mapping:

```text
ExplanationSource -> SourceSnapshot fallback
EvidenceExcerpt -> EvidenceExcerptRecord
Evidence -> ExtractedFact
Claim -> EvidenceClaim
ReasoningStep -> EvidenceReasoningStep
Uncertainty -> EvidenceUncertainty
VerificationSnapshot -> bundle.verification
```

The key upgrade is provenance and hashing.

---

## Tests

Add focused tests before broad integration.

### Hashing Tests

File: `tests/evidence-hash.test.ts`

Cases:

- canonical JSON sorts keys.
- hash is stable across object key order.
- undefined values do not alter hash unexpectedly.
- bundle hash excludes `bundleHash`.

### Recorder Tests

File: `tests/evidence-recorder.test.ts`

Cases:

- memory recorder stores snapshots, excerpts, and events.
- postgres recorder creates tables and persists records.
- duplicate IDs are idempotent or fail clearly.

### Bundle Builder Tests

File: `tests/evidence-bundle.test.ts`

Cases:

- builds from a `ResearchResult` with explanation data.
- falls back when source snapshots are missing.
- includes verification summary.
- computes stable hashes.
- output can be JSON serialized and parsed.

### Browse Integration Tests

File: `tests/evidence-browse.test.ts`

Cases:

- `browseOne` records a source snapshot when a recorder is provided.
- raw, cleaned, and summary hashes are present.
- excerpt extraction creates provenance events.
- no-op recorder preserves current behavior.

### Campaign Bundle Tests

File: `tests/campaign-evidence.test.ts`

Cases:

- campaign finalization can produce a bundle.
- bundle includes sources and notes across pulses.
- bundle links final report as an artifact.

---

## Implementation Plan

### Phase 1: Library Surface and Types

Deliverables:

- `src/lib.ts`
- package export metadata
- evidence type definitions
- hash/canonical JSON utilities
- tests for hashing and type-level bundle construction

This phase should not change runtime behavior.

### Phase 2: Bundle Builder From Existing Data

Deliverables:

- `buildEvidenceBundle(result)`
- `buildCampaignEvidenceBundle(campaignId)`
- fallback mapping from `ResearchResult.explanation`
- evidence JSON saved with `--evidence`
- tests for bundle generation

This phase provides immediate user value without changing the browse pipeline.

### Phase 3: Provenance Recorder

Deliverables:

- `EvidenceRecorder`
- memory/no-op/postgres implementations
- source snapshot and provenance tables
- integration with `browseOne`
- source hashes and excerpt records
- tests for browse recording

This phase gives real provenance instead of inferred provenance.

### Phase 4: Campaign Integration

Deliverables:

- campaign-level evidence recording
- final campaign evidence bundle
- `campaign_artifacts` entry for evidence bundle
- CLI export commands
- compact evidence summary command

### Phase 5: Better Structured Claims

Deliverables:

- optional structured claim extraction from reports
- stricter fact extraction modes
- contradiction records
- evidence graph renderer inputs
- richer eval support

This phase should be driven by observed needs after v1 bundle export is usable.

---

## Backward Compatibility

Existing behavior should continue:

- `bun run dev "topic"` still writes a markdown report.
- Campaigns still run as pulse sequences.
- Existing tests should pass with no evidence recorder enabled.
- `browse_cache` should not be removed.
- `ResearchResult` can gain optional fields but should not require new fields.

The evidence feature should be opt-in at first, then become default once stable.

Recommended rollout:

1. Internal APIs and tests.
2. `--evidence` opt-in.
3. Campaign `--evidence` opt-in.
4. Evidence JSON saved by default for new runs.

---

## Open Questions

### Should Raw Content Be Stored?

For local research, storing raw cleaned content in Postgres is acceptable. For team or hosted usage, raw content may contain copyrighted text, private data, or sensitive material.

Possible approach:

- Store hashes and metadata by default.
- Store cleaned text in local cache as today.
- Let users configure whether raw snapshots are persisted as artifacts.

### Should We Use WARC?

WARC is a strong archival format for web captures, but it is probably too much for v1.

Recommended:

- v1: source snapshots with content hashes and cache pointers.
- v2: optional WARC export for users who need archival-grade provenance.

### How Much Should Be Deterministic?

Fetching and hashing can be deterministic.

LLM extraction and verification are not fully deterministic.

The bundle should separate:

- observed source data,
- deterministic transformations,
- model-produced summaries/facts,
- verification judgments.

### Should Evidence Bundles Include Full Agent Messages?

Default: no.

Agent messages are useful for debugging but too large and sometimes noisy for evidence export.

Offer `includeMessages: true` for debug or eval workflows.

---

## Example Bundle

```json
{
  "schemaVersion": "evidence-bundle/v1",
  "bundleId": "bundle_9f1a...",
  "createdAt": "2026-05-27T12:00:00.000Z",
  "topic": "Did Organization X publish Report Y before May 20, 2026?",
  "mode": "extraction",
  "bundleHash": "sha256:...",
  "sourceManifestHash": "sha256:...",
  "evidenceGraphHash": "sha256:...",
  "sources": [
    {
      "id": "source_1",
      "url": "https://example.org/reports/report-y",
      "title": "Report Y",
      "sourceType": "official_source",
      "capturedAt": "2026-05-27T12:00:00.000Z",
      "capturedBy": { "kind": "agent", "id": "durable-researcher" },
      "adapter": { "name": "steel.scrape", "runtime": "steel" },
      "fetch": {
        "method": "GET",
        "retrievedAt": "2026-05-27T12:00:00.000Z",
        "rawLength": 18420
      },
      "raw": {
        "mediaType": "text/markdown",
        "charLength": 18420,
        "sha256": "sha256:..."
      },
      "cleaned": {
        "mediaType": "text/plain",
        "charLength": 16310,
        "sha256": "sha256:..."
      }
    }
  ],
  "excerpts": [
    {
      "id": "excerpt_1",
      "sourceId": "source_1",
      "text": "Report Y was published on May 18, 2026.",
      "sha256": "sha256:...",
      "extractedAt": "2026-05-27T12:00:03.000Z",
      "extractionMethod": "key_excerpts"
    }
  ],
  "facts": [
    {
      "id": "fact_1",
      "text": "Report Y was published on May 18, 2026.",
      "sourceIds": ["source_1"],
      "excerptIds": ["excerpt_1"],
      "confidence": "high",
      "extractedAt": "2026-05-27T12:00:04.000Z",
      "extractedBy": { "kind": "agent", "id": "durable-researcher" }
    }
  ],
  "claims": [
    {
      "id": "claim_1",
      "text": "Organization X published Report Y before May 20, 2026.",
      "sourceIds": ["source_1"],
      "excerptIds": ["excerpt_1"],
      "factIds": ["fact_1"],
      "confidence": "high",
      "verification": {
        "supported": true,
        "reason": "The excerpt states the report was published on May 18, 2026."
      }
    }
  ],
  "reasoning": [
    {
      "id": "reasoning_1",
      "title": "Deadline comparison",
      "content": "May 18, 2026 is before May 20, 2026.",
      "claimIds": ["claim_1"],
      "factIds": ["fact_1"],
      "sourceIds": ["source_1"]
    }
  ],
  "uncertainties": [],
  "verification": {
    "attempts": 1,
    "passRate": 1,
    "total": 1,
    "supported": 1,
    "unsupported": 0,
    "status": "passed",
    "rewriteTriggered": false
  },
  "provenance": [
    {
      "id": "prov_1",
      "type": "source_fetched",
      "at": "2026-05-27T12:00:00.000Z",
      "actor": { "kind": "agent", "id": "durable-researcher" },
      "inputIds": [],
      "outputIds": ["source_1"]
    },
    {
      "id": "prov_2",
      "type": "excerpt_extracted",
      "at": "2026-05-27T12:00:03.000Z",
      "actor": { "kind": "agent", "id": "durable-researcher" },
      "inputIds": ["source_1"],
      "outputIds": ["excerpt_1"]
    }
  ],
  "artifacts": []
}
```

---

## Why This Belongs in Durable Researcher

Durability is not only about surviving crashes.

For research, durability also means the answer can survive scrutiny.

A durable research artifact should be able to answer:

- What did we look at?
- When did we look at it?
- What did it say?
- Which claims depend on it?
- Which claims were unsupported?
- What changed between source capture, extraction, reasoning, and final report?

Evidence bundles make Durable Researcher more than a long-running report writer.

They make it an auditable research engine.

