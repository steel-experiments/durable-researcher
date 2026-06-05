// ABOUTME: Tests ResearchService run lifecycle guarantees without a live database.
// ABOUTME: Uses module mocks so pause/cancel ownership behavior stays deterministic.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchRunStatus } from "../src/service/research-runs.js";

const describeWithModuleMocks = (vi as unknown as { doMock?: unknown }).doMock ? describe : describe.skip;

type Row = {
  id: string;
  kind: string;
  campaign_id: string | null;
  status: ResearchRunStatus;
  topic: string;
  params: any;
  owner_id: string;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
  updated_at: Date;
};

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    sources: 0,
    models: {},
  };
}

async function setupServiceMock() {
  await (vi as unknown as { resetModules?: () => Promise<void> | void }).resetModules?.();
  const rows: Row[] = [];
  const events: any[] = [];
  let started!: () => void;
  let finish!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finishPromise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const signals: AbortSignal[] = [];

  vi.doMock("../src/db-pool.js", () => ({
    getDbPool: () => ({
      query: async (sql: string, params: any[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.startsWith("CREATE TABLE")) return { rows: [] };
        if (normalized.startsWith("INSERT INTO research_runs")) {
          const row: Row = {
            id: params[0],
            kind: params[1],
            campaign_id: null,
            status: "queued",
            topic: params[2],
            params: JSON.parse(params[3]),
            owner_id: params[4],
            idempotency_key: params[5],
            request_hash: params[6],
            created_at: new Date("2026-01-01T00:00:00.000Z"),
            updated_at: new Date("2026-01-01T00:00:00.000Z"),
          };
          if (rows.some((r) => r.owner_id === row.owner_id && r.idempotency_key === row.idempotency_key)) {
            return { rows: [] };
          }
          rows.push(row);
          return { rows: [row] };
        }
        if (normalized.startsWith("SELECT * FROM research_runs WHERE id = $1 AND owner_id = $2")) {
          return { rows: rows.filter((r) => r.id === params[0] && r.owner_id === params[1]) };
        }
        if (normalized.startsWith("SELECT * FROM research_runs WHERE owner_id = $1 AND idempotency_key = $2")) {
          return { rows: rows.filter((r) => r.owner_id === params[0] && r.idempotency_key === params[1]) };
        }
        if (normalized.startsWith("SELECT * FROM research_runs WHERE owner_id = $1 ORDER BY")) {
          return { rows: rows.filter((r) => r.owner_id === params[0]) };
        }
        if (normalized.startsWith("UPDATE research_runs SET status = $2")) {
          const row = rows.find((r) => r.id === params[0] && r.owner_id === params[2]);
          if (!row) return { rows: [] };
          const preserveStopped = params[3] === true;
          if (preserveStopped && (row.status === "paused" || row.status === "cancelled")) {
            return { rows: [] };
          }
          row.status = params[1];
          row.updated_at = new Date("2026-01-01T00:00:01.000Z");
          return { rows: [{ id: row.id }] };
        }
        if (normalized.startsWith("UPDATE research_runs SET campaign_id = $2")) {
          const row = rows.find((r) => r.id === params[0] && r.owner_id === params[3]);
          if (!row) return { rows: [] };
          row.campaign_id = params[1];
          row.status = params[2];
          return { rows: [{ id: row.id }] };
        }
        throw new Error(`Unexpected query: ${normalized}`);
      },
    }),
  }));

  vi.doMock("../src/campaign.js", () => ({
    getCampaign: vi.fn(async () => null),
    emptyCampaignUsage: emptyUsage,
    mergeCampaignUsage: (a: any, b: any) => ({ ...a, ...b }),
  }));
  vi.doMock("../src/service/research-events.js", () => ({
    ensureResearchEventSchema: vi.fn(async () => undefined),
    listResearchEvents: vi.fn(async () => events),
    recordResearchEvent: vi.fn(async (event: any) => {
      events.push(event);
    }),
  }));
  vi.doMock("../src/service/research-tasks.js", () => ({
    ensureResearchTaskSchema: vi.fn(async () => undefined),
    listResearchRunTasks: vi.fn(async () => []),
  }));
  vi.doMock("../src/service/research-artifacts.js", () => ({
    latestResearchArtifact: vi.fn(async () => null),
    listResearchArtifacts: vi.fn(async () => []),
  }));
  vi.doMock("../src/service/research-executors.js", () => ({
    campaignPulsesAsTasks: vi.fn(async () => []),
    latestTaskReport: vi.fn(async () => null),
    executorForHarness: vi.fn(() => ({
      start: vi.fn(async (_run: any, ctx: any) => {
        signals.push(ctx.signal);
        started();
        await finishPromise;
        await ctx.setRunStatus("completed");
      }),
    })),
  }));

  const { createResearchService } = await import(`../src/service/research-service.js?test=${Date.now()}-${Math.random()}`);
  return { service: createResearchService(), rows, startedPromise, finish, signals };
}

describeWithModuleMocks("ResearchService lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves cancelled status even if an active executor finishes later", async () => {
    const { service, startedPromise, finish, signals } = await setupServiceMock();
    const { run } = await service.createRun({
      ownerId: "alice",
      idempotencyKey: "idem-cancel",
      params: {
        topic: "browser agents",
        selectedHarness: { type: "single_agent" },
        budgets: {},
      },
    });

    await service.startRun(run.id, "alice");
    await startedPromise;
    const cancelled = await service.cancelRun(run.id, "alice");
    expect(cancelled.status).toBe("cancelled");
    expect(signals[0].aborted).toBe(true);

    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.getRun(run.id, "alice")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("checks ownership before resume mutates status", async () => {
    const { service, rows } = await setupServiceMock();
    const { run } = await service.createRun({
      ownerId: "alice",
      idempotencyKey: "idem-owner",
      params: {
        topic: "browser agents",
        selectedHarness: { type: "single_agent" },
        budgets: {},
      },
    });

    await expect(service.resumeRun(run.id, "bob")).rejects.toMatchObject({ code: "not_found" });
    expect(rows[0].status).toBe("queued");
  });
});
