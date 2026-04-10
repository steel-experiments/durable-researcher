# Cost Tracking Plan

## Goal

Add per-run cost accounting for the research agent in a way that is:

- future-proof
- easy to customize
- provider-agnostic
- resilient to price changes
- able to distinguish exact vs estimated cost

The current system already tracks token usage for LLM calls, but it does not convert that usage into dollar cost. It also does not track Steel cost per run.

## Current State

What exists now:

- per-run token usage aggregation in [`src/durable-turns.ts`](/home/agent/durable-researcher/src/durable-turns.ts)
- CLI printing of token counts in [`src/index.ts`](/home/agent/durable-researcher/src/index.ts)
- judge-side cost estimation in the eval harness, but only for benchmark judging, not for main research runs

What does not exist yet:

- per-run USD cost for Z.AI model usage
- per-run Steel cost
- line-item cost breakdown by provider and feature
- persisted run cost metadata

## Design Principle

Separate **metering** from **pricing**.

- Metering answers: "what was used?"
- Pricing answers: "what does that usage cost under a given pricing catalog?"

This separation is the key to keeping the system future-proof.

## Architecture

## 1. Introduce a Cost Ledger Layer

Add a new module, for example:

- [`src/costs.ts`](/home/agent/durable-researcher/src/costs.ts)

Responsibilities:

- define normalized usage event types
- load pricing catalog
- convert usage events into line items
- compute total run cost
- label each cost as `exact` or `estimated`

## 2. Represent Usage As Events

Do not store only aggregate totals.

Use normalized events such as:

```ts
type UsageEvent =
  | {
      kind: "llm_tokens";
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      timestamp: string;
    }
  | {
      kind: "tool_use";
      provider: string;
      tool: string;
      count: number;
      timestamp: string;
    }
  | {
      kind: "browser_time";
      provider: string;
      feature: string;
      durationMs: number;
      timestamp: string;
    }
  | {
      kind: "bandwidth";
      provider: string;
      gb: number;
      timestamp: string;
    }
  | {
      kind: "captcha";
      provider: string;
      count: number;
      timestamp: string;
    };
```

Why:

- future providers may bill on different units
- exact and estimated billing can coexist
- debugging becomes much easier

## 3. Store Pricing In Data, Not Code

Create a pricing catalog file, for example:

- [`config/pricing.json`](/home/agent/durable-researcher/config/pricing.json)

Structure should be versioned and provider-specific.

Example:

```json
{
  "version": "2026-04-09",
  "providers": {
    "zai": {
      "models": {
        "glm-5.1": {
          "inputPer1M": 1.4,
          "cachedInputPer1M": 0.26,
          "outputPer1M": 4.4
        },
        "glm-4.7-flashx": {
          "inputPer1M": 0.07,
          "cachedInputPer1M": 0.01,
          "outputPer1M": 0.4
        }
      },
      "tools": {
        "web_search": {
          "perUse": 0.01
        }
      }
    },
    "steel": {
      "plan": "developer",
      "browserHourUsd": 0.0,
      "captchaPer1kUsd": 0.0,
      "proxyPerGbUsd": 0.0,
      "roundBrowserMinutesUp": true
    }
  }
}
```

Why:

- price updates should not require logic changes
- custom enterprise plans can override defaults
- different environments can use different catalogs

## 4. Price Runs From The Catalog

At the end of a run, convert the usage events into:

- total cost
- line items
- pricing version
- confidence level

Suggested result shape:

```ts
type CostLineItem = {
  provider: string;
  category: string;
  label: string;
  amountUsd: number;
  basis: string;
  confidence: "exact" | "estimated";
};

type RunCost = {
  totalUsd: number;
  pricingVersion: string;
  lineItems: CostLineItem[];
  confidence: "exact" | "estimated";
};
```

## Provider-Specific Metering

## Z.AI

The current runtime already collects:

- input tokens
- output tokens
- cache-read tokens
- model name

This is enough to support pricing for text models.

Pricing formula:

```ts
costUsd =
  (inputTokens / 1_000_000) * inputPer1M +
  (cachedInputTokens / 1_000_000) * cachedInputPer1M +
  (outputTokens / 1_000_000) * outputPer1M;
```

Also support built-in tools such as:

- Web Search at `$0.01 / use`

If tool use is introduced later through the Z.AI API directly, meter it as `tool_use` events rather than hardcoding it into prompt logic.

## Steel

Steel should be handled through a metering abstraction, because pricing units may evolve and SDK exposure may vary.

The system should be able to support:

- browser/session time
- captcha solve count
- proxy bandwidth
- screenshot or scrape units if those become explicit billable metrics

Best case:

- Steel SDK exposes exact usage metadata per request or session

Fallback:

- measure request/session duration around Steel calls
- mark cost as `estimated`

This keeps the interface stable even if Steel later exposes better billing primitives.

## Confidence Model

Every run cost should carry one of:

- `exact`
- `estimated`

Examples:

- Z.AI token-derived pricing: likely `exact`
- Steel usage priced from measured request duration: likely `estimated`

If a run mixes both, the run-level confidence should degrade to `estimated`.

## Customization Strategy

## 1. Use Catalog Overrides

Support:

- repo default pricing in `config/pricing.json`
- local override via environment variable path, e.g. `PRICING_CATALOG_PATH`
- optional plan-specific overlays

This makes it easy to adapt for:

- enterprise contracts
- promotional pricing
- future provider changes

## 2. Keep Provider Logic Isolated

Each provider should have a small pricing adapter:

- `priceZaiEvent(...)`
- `priceSteelEvent(...)`
- `priceAnthropicEvent(...)`
- `priceOpenAIEvent(...)`

That way, adding providers later does not require rewriting the ledger.

## 3. Never Hardcode Prices In Runtime Logic

No pricing constants should live in:

- tools
- agent orchestration
- CLI output formatting

All prices should come from the catalog.

## Output Plan

The CLI should print:

- total run cost
- line-item breakdown
- pricing version
- exact vs estimated label

Example:

```text
--- Cost ---
Total: $0.21 (estimated)
  Z.AI / glm-5.1: $0.18
  Z.AI / glm-4.7-flashx: $0.01
  Steel / scrape usage: $0.02
Pricing catalog: 2026-04-09
```

The task result should also persist this metadata so it can be:

- shown later for completed runs
- exported into eval outputs
- used for cost/performance comparisons

## Suggested Rollout

### Phase 1

- Add pricing catalog
- Price existing Z.AI token usage
- Print per-run LLM cost

### Phase 2

- Add Steel usage event instrumentation
- Compute estimated Steel cost
- Print combined run cost

### Phase 3

- Persist cost in task results
- Add cost columns to task listing and eval summaries

### Phase 4

- Support catalog overrides and additional providers

## Reference Pricing To Seed The Catalog

Z.AI:

- GLM-5.1: input `$1.4 / 1M`, cached input `$0.26 / 1M`, output `$4.4 / 1M`
- GLM-4.7-FlashX: input `$0.07 / 1M`, cached input `$0.01 / 1M`, output `$0.4 / 1M`
- Web Search: `$0.01 / use`

Steel:

- Seed from the current Steel pricing and limits documentation
- Keep the exact catalog values external and versioned

## Bottom Line

The correct long-term implementation is not “add some cost formulas.”

It is:

- meter usage generically
- price usage from a versioned catalog
- keep provider pricing isolated
- preserve exact vs estimated confidence

That approach will survive model swaps, pricing changes, Steel plan changes, and future provider additions with minimal code churn.
