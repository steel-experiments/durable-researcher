// ABOUTME: Public ResearchRun DTOs and projection helpers for the service/API boundary.
// ABOUTME: Shields clients from campaign table internals while preserving useful progress data.

import type { CampaignBudgets, CampaignParams, CampaignPulse, CampaignRecord, CampaignUsage, TaskMode } from "../types.js";
import type { ExecutableHarness, ResearchHarness, ResearchOptimizationGoal } from "./research-harness.js";

export type ResearchRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type ResearchRunParams = {
  topic: string;
  depth?: CampaignParams["depth"];
  pulseDepth?: CampaignParams["pulseDepth"];
  pulseMaxSources?: number;
  mode?: TaskMode;
  clarify?: string;
  optimizeFor?: ResearchOptimizationGoal;
  harness?: ResearchHarness;
  selectedHarness?: ExecutableHarness;
  budgets: CampaignBudgets;
  stopWhenGoalMet?: boolean;
  stopWhenExhaustedSources?: boolean;
};

export type ResearchRun = {
  id: string;
  kind: ExecutableHarness["type"];
  campaignId: string | null;
  status: ResearchRunStatus;
  topic: string;
  params: ResearchRunParams;
  ownerId: string;
  usage: CampaignUsage;
  createdAt: Date;
  updatedAt: Date;
  deadlineAt: Date | null;
  stopReason: string | null;
  links: {
    self: string;
    report: string;
    pulses: string;
  };
};

export type ResearchRunPulse = {
  pulseIndex: number;
  status: CampaignPulse["status"];
  objective: string;
  taskId: string | null;
  decision: CampaignPulse["decision"];
  startedAt: Date;
  endedAt: Date | null;
};

export function statusFromCampaignStatus(status: CampaignRecord["status"]): ResearchRunStatus {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "finalizing":
      return "finalizing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

export function linksForRun(id: string): ResearchRun["links"] {
  return {
    self: `/v1/research-runs/${id}`,
    report: `/v1/research-runs/${id}/report`,
    pulses: `/v1/research-runs/${id}/pulses`,
  };
}

export function pulseToDto(pulse: CampaignPulse): ResearchRunPulse {
  return {
    pulseIndex: pulse.pulseIndex,
    status: pulse.status,
    objective: pulse.objective,
    taskId: pulse.taskId,
    decision: pulse.decision,
    startedAt: pulse.startedAt,
    endedAt: pulse.endedAt,
  };
}
