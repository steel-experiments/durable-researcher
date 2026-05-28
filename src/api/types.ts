// ABOUTME: HTTP API DTO types for versioned durable research runs.
// ABOUTME: Mirrors the OpenAPI contract without exposing internal campaign records.

import type { ResearchRun, ResearchRunParams, ResearchRunPulse } from "../service/research-runs.js";
import type { ResearchArtifact } from "../service/research-artifacts.js";
import type { ResearchRunEvent } from "../service/research-events.js";
import type { ResearchRunTask } from "../service/research-tasks.js";

export type CreateResearchRunRequest = ResearchRunParams;

export type ResearchRunResponse = ReturnType<typeof researchRunToResponse>;

export type ResearchRunListResponse = {
  data: ResearchRunResponse[];
};

export type ResearchRunReportResponse = {
  id: string;
  status: ResearchRun["status"];
  report: string | null;
  links: ResearchRun["links"];
};

export type ResearchRunPulsesResponse = {
  data: Array<{
    pulseIndex: number;
    status: ResearchRunPulse["status"];
    objective: string;
    taskId: string | null;
    decision: ResearchRunPulse["decision"];
    startedAt: string;
    endedAt: string | null;
  }>;
};

export type ResearchRunTasksResponse = {
  data: ReturnType<typeof taskToResponse>[];
};

export type ResearchArtifactsResponse = {
  data: ReturnType<typeof artifactToResponse>[];
};

export type ResearchEventsResponse = {
  data: ReturnType<typeof eventToResponse>[];
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
};

export function researchRunToResponse(run: ResearchRun) {
  return {
    id: run.id,
    kind: run.kind,
    campaignId: run.campaignId,
    status: run.status,
    topic: run.topic,
    params: run.params,
    usage: run.usage,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    deadlineAt: run.deadlineAt?.toISOString() ?? null,
    stopReason: run.stopReason,
    links: run.links,
  };
}

export function pulseToResponse(pulse: ResearchRunPulse): ResearchRunPulsesResponse["data"][number] {
  return {
    pulseIndex: pulse.pulseIndex,
    status: pulse.status,
    objective: pulse.objective,
    taskId: pulse.taskId,
    decision: pulse.decision,
    startedAt: pulse.startedAt.toISOString(),
    endedAt: pulse.endedAt?.toISOString() ?? null,
  };
}

export function taskToResponse(task: ResearchRunTask) {
  return {
    id: task.id,
    runId: task.runId,
    role: task.role,
    harnessType: task.harnessType,
    taskId: task.taskId,
    queueName: task.queueName,
    status: task.status,
    objective: task.objective,
    usage: task.usage,
    startedAt: task.startedAt?.toISOString() ?? null,
    endedAt: task.endedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
  };
}

export function artifactToResponse(artifact: ResearchArtifact) {
  return {
    id: artifact.id,
    runId: artifact.runId,
    kind: artifact.kind,
    contentType: artifact.contentType,
    content: artifact.content,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt.toISOString(),
  };
}

export function eventToResponse(event: ResearchRunEvent) {
  return {
    id: event.id,
    runId: event.runId,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}
