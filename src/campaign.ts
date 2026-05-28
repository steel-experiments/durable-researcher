// ABOUTME: Long-running research campaign orchestration over durable research tasks.
// ABOUTME: Provides an API-shaped CLI backend: create/status/resume/finalize with persisted state.

import { createHash, randomUUID } from "node:crypto";
import { createResearchApp } from "./agent.js";
import { getDbPool } from "./db-pool.js";
import {
  DEFAULT_PULSE_MAX_SOURCES,
  judgeCampaignProgress,
  shouldFinalizeFromDecision,
} from "./campaign-judge.js";
import type {
  CampaignBudgets,
  CampaignDecision,
  CampaignParams,
  CampaignPulse,
  CampaignRecord,
  CampaignUsage,
  ResearchNote,
  ResearchResult,
} from "./types.js";

const DEFAULT_FINALIZATION_RESERVE_RATIO = 0.08;

let schemaReady = false;

export {
  heuristicCampaignDecision,
  judgeCampaignProgress,
  shouldFinalizeFromDecision,
} from "./campaign-judge.js";

export function emptyCampaignUsage(): CampaignUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    sources: 0,
    models: {},
  };
}

export function mergeCampaignUsage(a: CampaignUsage, b: CampaignUsage): CampaignUsage {
  const models: CampaignUsage["models"] = { ...a.models };
  for (const [model, counts] of Object.entries(b.models)) {
    const existing = models[model] ?? { input: 0, output: 0 };
    models[model] = {
      input: existing.input + counts.input,
      output: existing.output + counts.output,
    };
  }
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    sources: a.sources + b.sources,
    models,
  };
}

export function estimateUsageCost(usage: CampaignUsage): number {
  const inputPerMillion = Number.parseFloat(process.env.AGENT_INPUT_PRICE_PER_1M ?? "0");
  const outputPerMillion = Number.parseFloat(process.env.AGENT_OUTPUT_PRICE_PER_1M ?? "0");
  const cachePerMillion = Number.parseFloat(process.env.AGENT_CACHE_READ_PRICE_PER_1M ?? "0");
  const sourcePrice = Number.parseFloat(process.env.STEEL_SOURCE_PRICE ?? "0");
  return (
    (usage.inputTokens / 1_000_000) * (Number.isFinite(inputPerMillion) ? inputPerMillion : 0) +
    (usage.outputTokens / 1_000_000) * (Number.isFinite(outputPerMillion) ? outputPerMillion : 0) +
    (usage.cacheReadTokens / 1_000_000) * (Number.isFinite(cachePerMillion) ? cachePerMillion : 0) +
    usage.sources * (Number.isFinite(sourcePrice) ? sourcePrice : 0)
  );
}

export function usageFromAgentUsage(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    models?: Record<string, { input: number; output: number }>;
  } | undefined,
  sourceCount: number,
): CampaignUsage {
  const out: CampaignUsage = {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    estimatedCostUsd: 0,
    sources: sourceCount,
    models: usage?.models ?? {},
  };
  out.estimatedCostUsd = estimateUsageCost(out);
  return out;
}

export function parseDurationMs(value: string): number {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/i);
  if (!m) throw new Error(`Invalid duration "${value}"`);
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid duration "${value}"`);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "ms" ? 1
    : unit === "s" ? 1_000
    : unit === "m" ? 60_000
    : unit === "h" ? 3_600_000
    : unit === "d" ? 86_400_000
    : unit === "w" ? 604_800_000
    : 1_000;
  return Math.round(n * mult);
}

export function parseTokenBudget(value: string): number {
  const m = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
  if (!m) throw new Error(`Invalid token budget "${value}"`);
  const n = Number.parseFloat(m[1]);
  const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : m[2] === "b" ? 1_000_000_000 : 1;
  return Math.round(n * mult);
}

export function parseCostBudget(value: string): number {
  const cleaned = value.trim().replace(/^\$/, "");
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid cost budget "${value}"`);
  return n;
}

export function hasFinalizationReserve(
  usage: CampaignUsage,
  budgets: CampaignBudgets,
): boolean {
  const reserve = budgets.finalizationReserveRatio ?? DEFAULT_FINALIZATION_RESERVE_RATIO;
  const spentTokens = usage.inputTokens + usage.outputTokens;
  if (budgets.maxTokens && spentTokens >= budgets.maxTokens * (1 - reserve)) return false;
  if (budgets.maxCostUsd && usage.estimatedCostUsd >= budgets.maxCostUsd * (1 - reserve)) return false;
  return true;
}

export function budgetStopReason(
  campaign: Pick<CampaignRecord, "createdAt" | "deadlineAt" | "usage" | "budgets">,
  now = new Date(),
): string | null {
  if (campaign.deadlineAt && now.getTime() >= campaign.deadlineAt.getTime()) {
    return "duration budget exhausted";
  }
  const spentTokens = campaign.usage.inputTokens + campaign.usage.outputTokens;
  if (campaign.budgets.maxTokens && spentTokens >= campaign.budgets.maxTokens) {
    return "token budget exhausted";
  }
  if (campaign.budgets.maxCostUsd && campaign.usage.estimatedCostUsd >= campaign.budgets.maxCostUsd) {
    return "cost budget exhausted";
  }
  if (campaign.budgets.maxSources && campaign.usage.sources >= campaign.budgets.maxSources) {
    return "source budget exhausted";
  }
  if (!hasFinalizationReserve(campaign.usage, campaign.budgets)) {
    return "finalization reserve reached";
  }
  return null;
}

async function ensureCampaignSchema(): Promise<void> {
  if (schemaReady) return;
  const pool = getDbPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_campaigns (
      id text PRIMARY KEY,
      topic text NOT NULL,
      status text NOT NULL,
      params jsonb NOT NULL,
      budgets jsonb NOT NULL,
      usage jsonb NOT NULL,
      deadline_at timestamptz,
      final_report text,
      stop_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_pulses (
      id bigserial PRIMARY KEY,
      campaign_id text NOT NULL REFERENCES research_campaigns(id) ON DELETE CASCADE,
      pulse_index integer NOT NULL,
      task_id text,
      queue_name text,
      objective text NOT NULL,
      status text NOT NULL,
      report text,
      result jsonb,
      decision jsonb,
      usage jsonb,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      UNIQUE (campaign_id, pulse_index)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_sources (
      campaign_id text NOT NULL REFERENCES research_campaigns(id) ON DELETE CASCADE,
      url text NOT NULL,
      title text NOT NULL,
      first_seen_pulse integer NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (campaign_id, url)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_notes (
      campaign_id text NOT NULL REFERENCES research_campaigns(id) ON DELETE CASCADE,
      note_hash text NOT NULL,
      title text NOT NULL,
      content text NOT NULL,
      confidence text NOT NULL,
      source_urls text[] NOT NULL,
      key_excerpts jsonb NOT NULL DEFAULT '[]'::jsonb,
      first_seen_pulse integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (campaign_id, note_hash)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_scores (
      id bigserial PRIMARY KEY,
      campaign_id text NOT NULL REFERENCES research_campaigns(id) ON DELETE CASCADE,
      pulse_index integer NOT NULL,
      decision jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_artifacts (
      id bigserial PRIMARY KEY,
      campaign_id text NOT NULL REFERENCES research_campaigns(id) ON DELETE CASCADE,
      kind text NOT NULL,
      content text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  schemaReady = true;
}

function rowToCampaign(row: {
  id: string;
  topic: string;
  status: CampaignRecord["status"];
  params: CampaignParams;
  budgets: CampaignBudgets;
  usage: CampaignUsage;
  created_at: Date;
  updated_at: Date;
  deadline_at: Date | null;
  final_report: string | null;
  stop_reason: string | null;
}): CampaignRecord {
  return {
    id: row.id,
    topic: row.topic,
    status: row.status,
    params: row.params,
    budgets: row.budgets,
    usage: row.usage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deadlineAt: row.deadline_at,
    finalReport: row.final_report,
    stopReason: row.stop_reason,
  };
}

function rowToPulse(row: {
  id: string | number;
  campaign_id: string;
  pulse_index: number;
  task_id: string | null;
  queue_name: string | null;
  objective: string;
  status: CampaignPulse["status"];
  started_at: Date;
  ended_at: Date | null;
  report: string | null;
  result: ResearchResult | null;
  decision: CampaignDecision | null;
  usage: CampaignUsage | null;
}): CampaignPulse {
  return {
    id: Number(row.id),
    campaignId: row.campaign_id,
    pulseIndex: row.pulse_index,
    taskId: row.task_id,
    queueName: row.queue_name,
    objective: row.objective,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    report: row.report,
    result: row.result,
    decision: row.decision,
    usage: row.usage,
  };
}

export async function createCampaign(params: CampaignParams): Promise<CampaignRecord> {
  await ensureCampaignSchema();
  const pool = getDbPool();
  const id = randomUUID();
  const budgets = {
    finalizationReserveRatio: DEFAULT_FINALIZATION_RESERVE_RATIO,
    ...params.budgets,
  };
  const deadlineAt = budgets.maxDurationMs
    ? new Date(Date.now() + budgets.maxDurationMs)
    : null;
  const usage = emptyCampaignUsage();
  const result = await pool.query(
    `INSERT INTO research_campaigns
       (id, topic, status, params, budgets, usage, deadline_at)
     VALUES ($1, $2, 'running', $3, $4, $5, $6)
     RETURNING *`,
    [id, params.topic, JSON.stringify({ ...params, budgets }), JSON.stringify(budgets), JSON.stringify(usage), deadlineAt],
  );
  return rowToCampaign(result.rows[0]);
}

export async function getCampaign(id: string): Promise<CampaignRecord | null> {
  await ensureCampaignSchema();
  const result = await getDbPool().query(`SELECT * FROM research_campaigns WHERE id = $1`, [id]);
  return result.rows[0] ? rowToCampaign(result.rows[0]) : null;
}

export async function listCampaigns(limit = 20): Promise<CampaignRecord[]> {
  await ensureCampaignSchema();
  const result = await getDbPool().query(
    `SELECT * FROM research_campaigns ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(rowToCampaign);
}

export async function listCampaignPulses(campaignId: string): Promise<CampaignPulse[]> {
  await ensureCampaignSchema();
  const result = await getDbPool().query(
    `SELECT * FROM campaign_pulses WHERE campaign_id = $1 ORDER BY pulse_index ASC`,
    [campaignId],
  );
  return result.rows.map(rowToPulse);
}

async function setCampaignStatus(
  campaignId: string,
  status: CampaignRecord["status"],
  stopReason?: string | null,
  finalReport?: string | null,
): Promise<void> {
  await getDbPool().query(
    `UPDATE research_campaigns
        SET status = $2,
            stop_reason = COALESCE($3, stop_reason),
            final_report = COALESCE($4, final_report),
            updated_at = now()
      WHERE id = $1`,
    [campaignId, status, stopReason ?? null, finalReport ?? null],
  );
}

async function beginPulse(
  campaignId: string,
  pulseIndex: number,
  objective: string,
): Promise<CampaignPulse> {
  const result = await getDbPool().query(
    `INSERT INTO campaign_pulses (campaign_id, pulse_index, objective, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING *`,
    [campaignId, pulseIndex, objective],
  );
  return rowToPulse(result.rows[0]);
}

async function completePulse(
  pulseId: number,
  patch: {
    taskId?: string;
    queueName?: string;
    status: CampaignPulse["status"];
    report?: string;
    result?: ResearchResult;
    decision?: CampaignDecision;
    usage?: CampaignUsage;
  },
): Promise<void> {
  await getDbPool().query(
    `UPDATE campaign_pulses
        SET task_id = COALESCE($2, task_id),
            queue_name = COALESCE($3, queue_name),
            status = $4,
            report = $5,
            result = $6,
            decision = $7,
            usage = $8,
            ended_at = now()
      WHERE id = $1`,
    [
      pulseId,
      patch.taskId ?? null,
      patch.queueName ?? null,
      patch.status,
      patch.report ?? null,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.decision ? JSON.stringify(patch.decision) : null,
      patch.usage ? JSON.stringify(patch.usage) : null,
    ],
  );
}

function noteHash(note: ResearchNote): string {
  return createHash("sha256")
    .update(note.title)
    .update("\n")
    .update(note.content)
    .digest("hex");
}

async function persistPulseEvidence(
  campaignId: string,
  pulseIndex: number,
  result: ResearchResult,
): Promise<{ newSourceCount: number; newNoteCount: number }> {
  const pool = getDbPool();
  let newSourceCount = 0;
  let newNoteCount = 0;
  for (const source of result.sources) {
    const inserted = await pool.query(
      `INSERT INTO campaign_sources (campaign_id, url, title, first_seen_pulse)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (campaign_id, url)
       DO UPDATE SET title = EXCLUDED.title, last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [campaignId, source.url, source.title, pulseIndex],
    );
    if (inserted.rows[0]?.inserted) newSourceCount++;
  }

  for (const note of result.notes) {
    const inserted = await pool.query(
      `INSERT INTO campaign_notes
         (campaign_id, note_hash, title, content, confidence, source_urls, key_excerpts, first_seen_pulse)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (campaign_id, note_hash) DO NOTHING
       RETURNING note_hash`,
      [
        campaignId,
        noteHash(note),
        note.title,
        note.content,
        note.confidence,
        note.sourceUrls,
        JSON.stringify(note.keyExcerpts ?? []),
        pulseIndex,
      ],
    );
    if ((inserted.rowCount ?? 0) > 0) newNoteCount++;
  }

  return { newSourceCount, newNoteCount };
}

async function addCampaignUsage(campaignId: string, pulseUsage: CampaignUsage): Promise<CampaignUsage> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
  const merged = mergeCampaignUsage(campaign.usage, pulseUsage);
  await getDbPool().query(
    `UPDATE research_campaigns SET usage = $2, updated_at = now() WHERE id = $1`,
    [campaignId, JSON.stringify(merged)],
  );
  return merged;
}

export async function loadCampaignNotes(campaignId: string): Promise<ResearchNote[]> {
  await ensureCampaignSchema();
  const result = await getDbPool().query(
    `SELECT title, content, confidence, source_urls, key_excerpts
       FROM campaign_notes
      WHERE campaign_id = $1
      ORDER BY created_at ASC`,
    [campaignId],
  );
  return result.rows.map((row: {
    title: string;
    content: string;
    confidence: ResearchNote["confidence"];
    source_urls: string[];
    key_excerpts: string[];
  }) => ({
    title: row.title,
    content: row.content,
    confidence: row.confidence,
    sourceUrls: row.source_urls,
    keyExcerpts: row.key_excerpts,
  }));
}

export async function loadCampaignSourceUrls(campaignId: string): Promise<string[]> {
  await ensureCampaignSchema();
  const result = await getDbPool().query(
    `SELECT url FROM campaign_sources WHERE campaign_id = $1 ORDER BY first_seen_pulse ASC, url ASC`,
    [campaignId],
  );
  return result.rows.map((row: { url: string }) => row.url);
}

async function recordDecision(campaignId: string, pulseIndex: number, decision: CampaignDecision): Promise<void> {
  await getDbPool().query(
    `INSERT INTO campaign_scores (campaign_id, pulse_index, decision) VALUES ($1, $2, $3)`,
    [campaignId, pulseIndex, JSON.stringify(decision)],
  );
}

function createCampaignQueueName(campaignId: string, pulseIndex: number): string {
  return `campaign_${campaignId.replace(/-/g, "").slice(0, 12)}_${pulseIndex}`;
}

function makePulseObjective(campaign: CampaignRecord, priorDecision: CampaignDecision | null, pulseIndex: number): string {
  if (pulseIndex === 0) {
    return "Build the initial evidence base: broad source discovery, primary sources where possible, and structured high-confidence notes with excerpts.";
  }
  return priorDecision?.nextObjective
    ?? "Continue the campaign by filling remaining gaps, finding novel sources, and strengthening auditability.";
}

export async function runCampaign(
  campaignId: string,
  opts: { maxPulses?: number; quiet?: boolean } = {},
): Promise<CampaignRecord> {
  await ensureCampaignSchema();
  let campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
  if (campaign.status === "completed") return campaign;
  if (campaign.status === "paused") {
    await setCampaignStatus(campaignId, "running");
    campaign = (await getCampaign(campaignId))!;
  }

  let pulses = await listCampaignPulses(campaignId);
  let priorDecision = pulses.at(-1)?.decision ?? null;
  const maxPulses = opts.maxPulses ?? Number.POSITIVE_INFINITY;
  let pulsesRun = 0;

  while (pulsesRun < maxPulses) {
    campaign = (await getCampaign(campaignId))!;
    const stopReason = budgetStopReason(campaign);
    if (stopReason) {
      await finalizeCampaign(campaignId, stopReason);
      return (await getCampaign(campaignId))!;
    }

    pulses = await listCampaignPulses(campaignId);
    const pulseIndex = pulses.length;
    const objective = makePulseObjective(campaign, priorDecision, pulseIndex);
    const pulse = await beginPulse(campaignId, pulseIndex, objective);
    const queueName = createCampaignQueueName(campaignId, pulseIndex);
    const app = createResearchApp({ queueName, quiet: opts.quiet ?? true });

    try {
      await app.createQueue();
      const priorNotes = await loadCampaignNotes(campaignId);
      const priorUrls = await loadCampaignSourceUrls(campaignId);
      const pulseMaxSources = Math.min(
        campaign.params.pulseMaxSources ?? DEFAULT_PULSE_MAX_SOURCES,
        Math.max(1, (campaign.budgets.maxSources ?? Number.MAX_SAFE_INTEGER) - campaign.usage.sources),
      );
      if (!opts.quiet) {
        const campaignSourceBudget = campaign.budgets.maxSources
          ? `${campaign.usage.sources}/${campaign.budgets.maxSources}`
          : `${campaign.usage.sources}/unbounded`;
        console.log(`\n=== Pulse ${pulseIndex + 1}: ${objective} ===`);
        console.log(`Campaign sources: ${campaignSourceBudget}; pulse source budget: ${pulseMaxSources}; prior sources: ${priorUrls.length}`);
      }
      const agentMaxSources = priorUrls.length + pulseMaxSources;
      const params = {
        topic: campaign.topic,
        depth: campaign.params.pulseDepth ?? campaign.params.depth ?? "standard",
        maxSources: agentMaxSources,
        priorNotes,
        priorUrls,
        mode: campaign.params.mode,
        clarifications: campaign.params.clarify,
        extensionInstruction: [
          `Long-running campaign pulse ${pulseIndex + 1}.`,
          `Campaign objective: ${objective}`,
          `This pulse may add up to ${pulseMaxSources} new sources; ${priorUrls.length} prior sources are already loaded for context.`,
          `Persist auditability: take notes with citations, source URLs, and excerpts.`,
          `Final reports must use numeric inline citations like [1] and a numbered Sources section.`,
          `Do not use markdown author links as citations.`,
          `Do not re-browse prior URLs unless needed to verify a specific claim.`,
        ].join("\n"),
      };
      const spawned = await app.spawn("research", params);
      await completePulse(pulse.id, { status: "running", taskId: spawned.taskID, queueName });
      const worker = await app.startWorker({ concurrency: 1, claimTimeout: 600 });
      let resultState;
      try {
        resultState = await app.awaitTaskResult(spawned.taskID, {
          queue: queueName,
          timeout: campaign.deadlineAt
            ? Math.max(60, Math.ceil((campaign.deadlineAt.getTime() - Date.now()) / 1000) + 30)
            : 24 * 60 * 60,
        });
      } finally {
        await worker.close();
      }

      if (resultState.state !== "completed" || !resultState.result) {
        await completePulse(pulse.id, { status: "failed", taskId: spawned.taskID, queueName });
        const failure = resultState.state === "failed" ? resultState.failure : resultState.state;
        throw new Error(`Pulse ${pulseIndex} failed: ${JSON.stringify(failure)}`);
      }

      const research = resultState.result as unknown as ResearchResult;
      const rawUsage = (app as any).getLastUsage?.();
      const evidence = await persistPulseEvidence(campaignId, pulseIndex, research);
      const pulseUsage = usageFromAgentUsage(rawUsage, evidence.newSourceCount);
      await addCampaignUsage(campaignId, pulseUsage);
      const allNotes = await loadCampaignNotes(campaignId);
      const allSources = await loadCampaignSourceUrls(campaignId);
      campaign = (await getCampaign(campaignId))!;
      const decision = await judgeCampaignProgress({
        campaign,
        pulseIndex,
        latestReport: research.report,
        notes: allNotes,
        totalSources: allSources.length,
        newSourceCount: evidence.newSourceCount,
        newNoteCount: evidence.newNoteCount,
        verificationPassRate: research.verification?.passRate,
        verificationTotal: research.verification?.total,
        verificationStatus: research.verification?.status,
      });
      await recordDecision(campaignId, pulseIndex, decision);
      await completePulse(pulse.id, {
        status: "completed",
        taskId: spawned.taskID,
        queueName,
        report: research.report,
        result: research,
        decision,
        usage: pulseUsage,
      });
      priorDecision = decision;
      pulsesRun++;

      if (shouldFinalizeFromDecision(campaign.params, decision)) {
        await finalizeCampaign(campaignId, decision.reason);
        return (await getCampaign(campaignId))!;
      }
    } catch (err) {
      await completePulse(pulse.id, { status: "failed" });
      await setCampaignStatus(campaignId, "failed", (err as Error).message);
      throw err;
    } finally {
      await app.close();
    }
  }

  return (await getCampaign(campaignId))!;
}

export async function pauseCampaign(campaignId: string): Promise<void> {
  await ensureCampaignSchema();
  await setCampaignStatus(campaignId, "paused");
}

export async function compileCampaignReport(campaignId: string): Promise<string> {
  await ensureCampaignSchema();
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
  const pulses = await listCampaignPulses(campaignId);
  const notes = await loadCampaignNotes(campaignId);
  const sources = await getDbPool().query(
    `SELECT url, title, first_seen_pulse FROM campaign_sources WHERE campaign_id = $1 ORDER BY first_seen_pulse ASC, title ASC`,
    [campaignId],
  );
  const decisions = pulses.filter((p) => p.decision).map((p) => p.decision!);
  const lines = [
    `# ${campaign.topic}`,
    "",
    "## Campaign Summary",
    "",
    `- Campaign ID: ${campaign.id}`,
    `- Status: ${campaign.status}`,
    `- Pulses completed: ${pulses.filter((p) => p.status === "completed").length}`,
    `- Sources: ${sources.rowCount}`,
    `- Notes: ${notes.length}`,
    `- Usage: ${campaign.usage.inputTokens.toLocaleString()} input tokens, ${campaign.usage.outputTokens.toLocaleString()} output tokens, ${campaign.usage.sources.toLocaleString()} source fetches`,
    campaign.stopReason ? `- Stop reason: ${campaign.stopReason}` : null,
    "",
    "## Executive Synthesis",
    "",
    ...pulses
      .filter((p) => p.report)
      .map((p) => [`### Pulse ${p.pulseIndex + 1}: ${p.objective}`, "", p.report!])
      .flat(),
    "",
    "## Evidence Ledger",
    "",
    ...notes.map((n, i) => [
      `### ${i + 1}. ${n.title}`,
      "",
      `Confidence: ${n.confidence}`,
      "",
      n.content,
      "",
      `Sources: ${n.sourceUrls.join(", ")}`,
      ...(n.keyExcerpts?.length ? ["", "Key excerpts:", ...n.keyExcerpts.map((e) => `- "${e}"`)] : []),
      "",
    ]).flat(),
    "## Annotated Bibliography",
    "",
    ...sources.rows.map((s: { title: string; url: string; first_seen_pulse: number }, i: number) =>
      `${i + 1}. ${s.title} — ${s.url} (first seen in pulse ${s.first_seen_pulse + 1})`
    ),
    "",
    "## Judge History",
    "",
    ...decisions.map((d, i) =>
      `- Pulse ${i + 1}: ${d.decision} (${d.reason}); coverage=${d.coverageScore.toFixed(2)}, novelty=${d.noveltyScore.toFixed(2)}, auditability=${d.auditabilityScore.toFixed(2)}`
    ),
    "",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export async function finalizeCampaign(campaignId: string, reason = "finalized"): Promise<string> {
  await ensureCampaignSchema();
  await setCampaignStatus(campaignId, "finalizing", reason);
  const report = await compileCampaignReport(campaignId);
  await getDbPool().query(
    `INSERT INTO campaign_artifacts (campaign_id, kind, content, metadata)
     VALUES ($1, 'final-report', $2, $3)`,
    [campaignId, report, JSON.stringify({ reason })],
  );
  await setCampaignStatus(campaignId, "completed", reason, report);
  return report;
}
