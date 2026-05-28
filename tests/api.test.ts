// ABOUTME: Tests for the durable researcher HTTP API contract.
// ABOUTME: Uses a fake service so route/auth/validation behavior stays fast and deterministic.

import { afterEach, describe, expect, it, vi } from "vitest";
import docsOpenApi from "../docs/api/openapi.json";
import { createApiHandler } from "../src/api/routes.js";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";
import { emptyCampaignUsage } from "../src/campaign.js";
import type { ResearchService } from "../src/service/research-service.js";
import type { ResearchRun } from "../src/service/research-runs.js";
import { notFound } from "../src/service/research-errors.js";

const date = new Date("2026-01-01T00:00:00.000Z");

function run(overrides: Partial<ResearchRun> = {}): ResearchRun {
  return {
    id: "run_123",
    kind: "campaign_pulses",
    campaignId: "campaign_123",
    status: "running",
    topic: "browser agents",
    params: {
      topic: "browser agents",
      depth: "standard",
      harness: { type: "campaign_pulses" },
      selectedHarness: { type: "campaign_pulses" },
      budgets: {},
    },
    ownerId: "default",
    usage: emptyCampaignUsage(),
    createdAt: date,
    updatedAt: date,
    deadlineAt: null,
    stopReason: null,
    links: {
      self: "/v1/research-runs/run_123",
      report: "/v1/research-runs/run_123/report",
      pulses: "/v1/research-runs/run_123/pulses",
    },
    ...overrides,
  };
}

function service(overrides: Partial<ResearchService> = {}): ResearchService {
  return {
    createRun: vi.fn(async () => ({ run: run(), created: true })),
    getRun: vi.fn(async () => run()),
    listRuns: vi.fn(async () => [run()]),
    listPulses: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
    listArtifacts: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    getReport: vi.fn(async () => ({ run: run({ status: "completed" }), report: "final report" })),
    startRun: vi.fn(async () => run()),
    pauseRun: vi.fn(async () => run({ status: "paused" })),
    resumeRun: vi.fn(async () => run({ status: "running" })),
    finalizeRun: vi.fn(async () => ({ run: run({ status: "completed" }), report: "final report" })),
    cancelRun: vi.fn(async () => run({ status: "cancelled" })),
    ...overrides,
  } as ResearchService;
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe("API routes", () => {
  const oldEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...oldEnv };
    vi.restoreAllMocks();
  });

  it("keeps docs OpenAPI JSON synchronized with the served document", () => {
    expect(docsOpenApi).toEqual(OPENAPI_DOCUMENT);
  });

  it("rejects unauthorized production requests", async () => {
    process.env.NODE_ENV = "production";
    process.env.DURABLE_RESEARCHER_API_KEY = "secret";
    const response = await createApiHandler(service())(
      new Request("http://localhost/v1/research-runs"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
  });

  it("creates a run with 202, Location, Retry-After, and starts it in background", async () => {
    process.env.DURABLE_RESEARCHER_API_KEY = "secret";
    const fake = service();
    const response = await createApiHandler(fake)(
      new Request("http://localhost/v1/research-runs", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-key-1",
        },
        body: JSON.stringify({ topic: " browser agents ", depth: "quick" }),
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toBe("/v1/research-runs/run_123");
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(fake.createRun).toHaveBeenCalledWith({
      ownerId: "default",
      idempotencyKey: "idem-key-1",
      params: {
        topic: "browser agents",
        depth: "quick",
        pulseDepth: undefined,
        pulseMaxSources: undefined,
        mode: undefined,
        clarify: undefined,
        optimizeFor: undefined,
        harness: { type: "campaign_pulses" },
        selectedHarness: { type: "campaign_pulses" },
        budgets: {
          maxDurationMs: undefined,
          maxTokens: undefined,
          maxCostUsd: undefined,
          maxSources: undefined,
          finalizationReserveRatio: undefined,
        },
        stopWhenGoalMet: undefined,
        stopWhenExhaustedSources: undefined,
      },
    });
    expect(fake.startRun).toHaveBeenCalledWith("run_123", "default");
  });

  it("requires idempotency key when creating runs", async () => {
    const response = await createApiHandler(service())(
      new Request("http://localhost/v1/research-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "browser agents" }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await json(response)).detail).toMatch(/Idempotency-Key/);
  });

  it("validates create request bodies", async () => {
    const response = await createApiHandler(service())(
      new Request("http://localhost/v1/research-runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-key-2",
        },
        body: JSON.stringify({ depth: "fast" }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await json(response)).detail).toMatch(/topic is required/);
  });

  it("accepts multi-agent harness requests in the public contract", async () => {
    const fake = service();
    const response = await createApiHandler(fake)(
      new Request("http://localhost/v1/research-runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-key-team",
        },
        body: JSON.stringify({
          topic: "browser agents",
          optimizeFor: "latency",
          harness: { type: "fixed_team", agents: 5, perAgentTokenLimit: 1000000 },
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(fake.createRun).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        optimizeFor: "latency",
        harness: { type: "fixed_team", agents: 5, perAgentTokenLimit: 1000000, totalTokenLimit: undefined },
        selectedHarness: { type: "fixed_team", agents: 5, perAgentTokenLimit: 1000000, totalTokenLimit: undefined },
      }),
    }));
  });

  it("rejects invalid harness values", async () => {
    const response = await createApiHandler(service())(
      new Request("http://localhost/v1/research-runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-key-bad-harness",
        },
        body: JSON.stringify({
          topic: "browser agents",
          harness: { type: "fixed_team", agents: 0 },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await json(response)).detail).toMatch(/harness\.agents/);
  });

  it("lists, reads, reports, tasks, artifacts, and pulses", async () => {
    const fake = service({
      listPulses: vi.fn(async () => [{
        id: "task_row_1",
        runId: "run_123",
        role: "pulse-1",
        harnessType: "campaign_pulses",
        status: "completed",
        objective: "initial evidence",
        taskId: "task_1",
        queueName: "queue_1",
        result: null,
        usage: null,
        startedAt: date,
        endedAt: date,
        createdAt: date,
      }]),
      listTasks: vi.fn(async () => [{
        id: "task_row_1",
        runId: "run_123",
        role: "agent-1",
        harnessType: "fixed_team",
        taskId: "task_1",
        queueName: "queue_1",
        status: "completed",
        objective: "initial evidence",
        result: null,
        usage: null,
        startedAt: date,
        endedAt: date,
        createdAt: date,
      }]),
      listArtifacts: vi.fn(async () => [{
        id: 1,
        runId: "run_123",
        kind: "final-report",
        contentType: "text/markdown",
        content: "final report",
        metadata: {},
        createdAt: date,
      }]),
      listEvents: vi.fn(async () => [{
        id: 1,
        runId: "run_123",
        type: "run.created",
        payload: {},
        createdAt: date,
      }]),
    });
    const handler = createApiHandler(fake);

    expect((await json(await handler(new Request("http://localhost/v1/research-runs")))).data[0].id).toBe("run_123");
    expect((await json(await handler(new Request("http://localhost/v1/research-runs/run_123")))).id).toBe("run_123");
    expect((await json(await handler(new Request("http://localhost/v1/research-runs/run_123/report")))).report).toBe("final report");
    expect((await json(await handler(new Request("http://localhost/v1/research-runs/run_123/pulses")))).data[0].taskId).toBe("task_1");
    expect((await json(await handler(new Request("http://localhost/v1/research-runs/run_123/tasks")))).data[0].role).toBe("agent-1");
    expect((await json(await handler(new Request("http://localhost/v1/research-runs/run_123/artifacts")))).data[0].kind).toBe("final-report");
    expect((await json(await handler(new Request("http://localhost/v1/research-runs/run_123/events")))).data[0].type).toBe("run.created");
    expect((await json(await handler(new Request("http://localhost/v1/research-runs/run_123/actions/cancel", { method: "POST" })))).status).toBe("cancelled");
  });

  it("maps service not-found errors to problem details", async () => {
    const response = await createApiHandler(service({
      getRun: vi.fn(async () => {
        throw notFound("Research run not found: missing");
      }),
    }))(new Request("http://localhost/v1/research-runs/missing"));

    expect(response.status).toBe(404);
    expect((await json(response)).type).toContain("/not_found");
  });
});
