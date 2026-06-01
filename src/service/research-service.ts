// ABOUTME: Application service for durable research runs.
// ABOUTME: Owns the stable ResearchRun boundary, idempotency, and campaign lifecycle mapping.

import { createHash, randomUUID } from "node:crypto";
import { getDbPool } from "../db-pool.js";
import { getCampaign } from "../campaign.js";
import { emptyCampaignUsage, mergeCampaignUsage } from "../campaign.js";
import type { CampaignRecord, CampaignUsage } from "../types.js";
import {
  latestResearchArtifact,
  listResearchArtifacts,
  type ResearchArtifact,
} from "./research-artifacts.js";
import {
  campaignPulsesAsTasks,
  executorForHarness,
  latestTaskReport,
} from "./research-executors.js";
import { ensureResearchEventSchema, listResearchEvents, recordResearchEvent, type ResearchRunEvent } from "./research-events.js";
import { conflict, notFound } from "./research-errors.js";
import { selectHarness, type ExecutableHarness } from "./research-harness.js";
import {
  linksForRun,
  statusFromCampaignStatus,
  type ResearchRun,
  type ResearchRunParams,
  type ResearchRunStatus,
} from "./research-runs.js";
import { ensureResearchTaskSchema, listResearchRunTasks, type ResearchRunTask } from "./research-tasks.js";

let schemaReady = false;

type ResearchRunRow = {
  id: string;
  kind: ExecutableHarness["type"] | "campaign";
  campaign_id: string | null;
  status: ResearchRunStatus;
  topic: string;
  params: ResearchRunParams;
  owner_id: string;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
  updated_at: Date;
};

export type CreateResearchRunInput = {
  params: ResearchRunParams;
  ownerId?: string;
  idempotencyKey: string;
};

export type ResearchService = ReturnType<typeof createResearchService>;

type ActiveRun = {
  promise: Promise<void>;
  abortController: AbortController;
};

const STOPPED_STATUSES = new Set<ResearchRunStatus>(["paused", "cancelled"]);
const activeRuns = new Map<string, ActiveRun>();

async function ensureResearchRunSchema(): Promise<void> {
  if (schemaReady) return;
  await getDbPool().query(`
    CREATE TABLE IF NOT EXISTS research_runs (
      id text PRIMARY KEY,
      kind text NOT NULL,
      campaign_id text,
      status text NOT NULL,
      topic text NOT NULL,
      params jsonb NOT NULL,
      owner_id text NOT NULL DEFAULT 'default',
      idempotency_key text NOT NULL,
      request_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_id, idempotency_key)
    )
  `);
  await ensureResearchTaskSchema();
  await ensureResearchEventSchema();
  schemaReady = true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(params: ResearchRunParams): string {
  return createHash("sha256").update(stableJson(params)).digest("hex");
}

function rowToRun(
  row: ResearchRunRow,
  campaign: CampaignRecord | null,
  taskUsage = emptyCampaignUsage(),
): ResearchRun {
  const params = normalizeRunParams(row.params);
  const campaignStatus = campaign ? statusFromCampaignStatus(campaign.status) : null;
  const status = row.status === "queued" ||
    row.status === "paused" ||
    row.status === "cancelled" ||
    row.status === "failed" ||
    (row.status === "running" && campaignStatus === "paused")
    ? row.status
    : campaignStatus ?? row.status;
  return {
    id: row.id,
    kind: row.kind === "campaign" ? "campaign_pulses" : row.kind,
    campaignId: row.campaign_id,
    status,
    topic: row.topic,
    params,
    ownerId: row.owner_id,
    usage: campaign?.usage ?? taskUsage,
    createdAt: row.created_at,
    updatedAt: campaign?.updatedAt ?? row.updated_at,
    deadlineAt: campaign?.deadlineAt ?? null,
    stopReason: campaign?.stopReason ?? null,
    links: linksForRun(row.id),
  };
}

function normalizeRunParams(params: ResearchRunParams): ResearchRunParams {
  const selectedHarness = params.selectedHarness ?? selectHarness(params.harness, params.optimizeFor);
  return {
    ...params,
    harness: params.harness ?? selectedHarness,
    selectedHarness,
  };
}

async function fetchRunRow(id: string, ownerId: string): Promise<ResearchRunRow | null> {
  await ensureResearchRunSchema();
  const result = await getDbPool().query(
    `SELECT * FROM research_runs WHERE id = $1 AND owner_id = $2`,
    [id, ownerId],
  );
  return result.rows[0] ?? null;
}

async function campaignForRow(row: ResearchRunRow): Promise<CampaignRecord | null> {
  return row.campaign_id ? getCampaign(row.campaign_id) : null;
}

async function taskUsageForRun(runId: string): Promise<CampaignUsage> {
  const tasks = await listResearchRunTasks(runId);
  return tasks.reduce(
    (usage, task) => task.usage ? mergeCampaignUsage(usage, task.usage) : usage,
    emptyCampaignUsage(),
  );
}

async function setRunCampaign(runId: string, ownerId: string, campaignId: string, status: ResearchRunStatus): Promise<void> {
  const result = await getDbPool().query(
    `UPDATE research_runs
        SET campaign_id = $2, status = $3, updated_at = now()
      WHERE id = $1 AND owner_id = $4
      RETURNING id`,
    [runId, campaignId, status, ownerId],
  );
  if (!result.rows[0]) return;
  await recordResearchEvent({ runId, type: "run.campaign_linked", payload: { campaignId, status } });
}

async function setRunStatus(
  runId: string,
  ownerId: string,
  status: ResearchRunStatus,
  opts: { preserveStopped?: boolean } = {},
): Promise<boolean> {
  const result = await getDbPool().query(
    `UPDATE research_runs
        SET status = $2, updated_at = now()
      WHERE id = $1
        AND owner_id = $3
        AND (
          $4::boolean = false
          OR status NOT IN ('paused', 'cancelled')
        )
      RETURNING id`,
    [runId, status, ownerId, opts.preserveStopped ?? false],
  );
  if (!result.rows[0]) return false;
  await recordResearchEvent({ runId, type: `run.${status}`, payload: { status } });
  return true;
}

export function createResearchService() {
  async function createRun(input: CreateResearchRunInput): Promise<{ run: ResearchRun; created: boolean }> {
    await ensureResearchRunSchema();
    const ownerId = input.ownerId ?? "default";
    const params = normalizeRunParams(input.params);
    const requestHash = hashRequest(params);
    const id = `run_${randomUUID()}`;
    const inserted = await getDbPool().query(
      `INSERT INTO research_runs
         (id, kind, status, topic, params, owner_id, idempotency_key, request_hash)
       VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7)
       ON CONFLICT (owner_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [id, params.selectedHarness!.type, params.topic, JSON.stringify(params), ownerId, input.idempotencyKey, requestHash],
    );

    if (inserted.rows[0]) {
      const row = await fetchRunRow(id, ownerId);
      if (!row) throw new Error(`Created run disappeared: ${id}`);
      await recordResearchEvent({ runId: id, type: "run.created", payload: { harness: params.selectedHarness!.type } });
      return { run: rowToRun(row, null), created: true };
    }

    const existing = await getDbPool().query(
      `SELECT * FROM research_runs WHERE owner_id = $1 AND idempotency_key = $2`,
      [ownerId, input.idempotencyKey],
    );
    const row = existing.rows[0] as ResearchRunRow | undefined;
    if (!row) throw new Error("Idempotency lookup failed after conflict");
    if (row.request_hash !== requestHash) {
      throw conflict("Idempotency-Key was already used with a different request body");
    }
    const campaign = await campaignForRow(row);
    return { run: rowToRun(row, campaign, campaign ? undefined : await taskUsageForRun(row.id)), created: false };
  }

  async function getRun(id: string, ownerId = "default"): Promise<ResearchRun> {
    const row = await fetchRunRow(id, ownerId);
    if (!row) throw notFound(`Research run not found: ${id}`);
    const campaign = await campaignForRow(row);
    return rowToRun(row, campaign, campaign ? undefined : await taskUsageForRun(row.id));
  }

  async function listRuns(ownerId = "default", limit = 20): Promise<ResearchRun[]> {
    await ensureResearchRunSchema();
    const result = await getDbPool().query(
      `SELECT * FROM research_runs WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [ownerId, limit],
    );
    const runs: ResearchRun[] = [];
    for (const row of result.rows as ResearchRunRow[]) {
      const campaign = await campaignForRow(row);
      runs.push(rowToRun(row, campaign, campaign ? undefined : await taskUsageForRun(row.id)));
    }
    return runs;
  }

  async function listTasks(id: string, ownerId = "default"): Promise<ResearchRunTask[]> {
    const run = await getRun(id, ownerId);
    const tasks = await listResearchRunTasks(id);
    if (run.kind === "campaign_pulses") {
      return [...tasks, ...(await campaignPulsesAsTasks(run))];
    }
    return tasks;
  }

  async function listPulses(id: string, ownerId = "default"): Promise<ResearchRunTask[]> {
    return listTasks(id, ownerId);
  }

  async function listArtifacts(id: string, ownerId = "default"): Promise<ResearchArtifact[]> {
    await getRun(id, ownerId);
    return listResearchArtifacts(id);
  }

  async function listEvents(
    id: string,
    ownerId = "default",
    opts: { afterId?: number; limit?: number } = {},
  ): Promise<ResearchRunEvent[]> {
    await getRun(id, ownerId);
    return listResearchEvents(id, opts);
  }

  async function getReport(id: string, ownerId = "default"): Promise<{ run: ResearchRun; report: string | null }> {
    const run = await getRun(id, ownerId);
    const artifact = await latestResearchArtifact(id, "final-report");
    if (artifact) return { run, report: artifact.content };
    if (run.kind !== "campaign_pulses") return { run, report: await latestTaskReport(run) };
    if (!run.campaignId) return { run, report: null };
    const campaign = await getCampaign(run.campaignId);
    if (!campaign) return { run, report: null };
    return { run, report: campaign.finalReport };
  }

  async function startRun(id: string, ownerId = "default"): Promise<ResearchRun> {
    const run = await getRun(id, ownerId);
    const active = activeRuns.get(id);
    if (active) {
      if (!active.abortController.signal.aborted) return run;
      await active.promise.catch(() => undefined);
    }
    await setRunStatus(id, ownerId, "running");
    const executor = executorForHarness(run.params.selectedHarness!);
    const abortController = new AbortController();
    const promise = executor.start(run, {
      signal: abortController.signal,
      setRunStatus: (status) => setRunStatus(id, ownerId, status, { preserveStopped: true }).then(() => undefined),
      setRunCampaign: (campaignId, status) => setRunCampaign(id, ownerId, campaignId, status),
    })
      .then(async () => {
        const current = await getRun(id, ownerId);
        if (current.status === "running") await setRunStatus(id, ownerId, "completed", { preserveStopped: true });
      })
      .catch(async (err) => {
        const current = await getRun(id, ownerId).catch(() => null);
        if (abortController.signal.aborted || (current && STOPPED_STATUSES.has(current.status))) return;
        await setRunStatus(id, ownerId, "failed", { preserveStopped: true });
        throw err;
      })
      .finally(() => {
        activeRuns.delete(id);
      });
    activeRuns.set(id, { promise, abortController });
    return run;
  }

  async function recordRunStartFailure(id: string, ownerId = "default", err: unknown): Promise<void> {
    await getRun(id, ownerId);
    const error = err instanceof Error
      ? { name: err.name, message: err.message }
      : { message: String(err) };
    await recordResearchEvent({
      runId: id,
      type: "run.start_failed",
      payload: { error },
    });
  }

  async function pauseRun(id: string, ownerId = "default"): Promise<ResearchRun> {
    const run = await getRun(id, ownerId);
    const executor = executorForHarness(run.params.selectedHarness!);
    if (executor.pause) {
      await executor.pause(run, {
        signal: activeRuns.get(id)?.abortController.signal ?? new AbortController().signal,
        setRunStatus: (status) => setRunStatus(id, ownerId, status, { preserveStopped: true }).then(() => undefined),
        setRunCampaign: (campaignId, status) => setRunCampaign(id, ownerId, campaignId, status),
      });
    } else {
      await setRunStatus(id, ownerId, "paused");
    }
    activeRuns.get(id)?.abortController.abort();
    return getRun(id, ownerId);
  }

  async function resumeRun(id: string, ownerId = "default"): Promise<ResearchRun> {
    await getRun(id, ownerId);
    await setRunStatus(id, ownerId, "running");
    const resumed = await getRun(id, ownerId);
    void startRun(id, ownerId).catch(() => undefined);
    return resumed;
  }

  async function finalizeRun(id: string, ownerId = "default"): Promise<{ run: ResearchRun; report: string }> {
    const run = await getRun(id, ownerId);
    const executor = executorForHarness(run.params.selectedHarness!);
    const report = executor.finalize
      ? await executor.finalize(run, {
          signal: activeRuns.get(id)?.abortController.signal ?? new AbortController().signal,
          setRunStatus: (status) => setRunStatus(id, ownerId, status, { preserveStopped: true }).then(() => undefined),
          setRunCampaign: (campaignId, status) => setRunCampaign(id, ownerId, campaignId, status),
        })
      : (await getReport(id, ownerId)).report ?? "";
    await setRunStatus(id, ownerId, "completed", { preserveStopped: true });
    return { run: await getRun(id, ownerId), report };
  }

  async function cancelRun(id: string, ownerId = "default"): Promise<ResearchRun> {
    await getRun(id, ownerId);
    await setRunStatus(id, ownerId, "cancelled");
    activeRuns.get(id)?.abortController.abort();
    return getRun(id, ownerId);
  }

  return {
    createRun,
    getRun,
    listRuns,
    listPulses,
    listTasks,
    listArtifacts,
    listEvents,
    getReport,
    startRun,
    recordRunStartFailure,
    pauseRun,
    resumeRun,
    finalizeRun,
    cancelRun,
  };
}
