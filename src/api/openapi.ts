// ABOUTME: OpenAPI 3.1 contract for the durable researcher HTTP API.
// ABOUTME: Served by the API and mirrored into docs/api/openapi.json.

export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Durable Researcher API",
    version: "0.1.0",
    description: "Versioned API for creating and monitoring durable research runs.",
  },
  paths: {
    "/v1/openapi.json": {
      get: {
        summary: "Return this OpenAPI document",
        responses: {
          "200": {
            description: "OpenAPI document",
          },
        },
      },
    },
    "/v1/research-runs": {
      post: {
        summary: "Create a durable research run",
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateResearchRunRequest" },
            },
          },
        },
        responses: {
          "202": {
            description: "Research run accepted",
            headers: {
              Location: { schema: { type: "string" } },
              "Retry-After": { schema: { type: "string" } },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResearchRun" },
              },
            },
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "409": { $ref: "#/components/responses/Problem" },
        },
      },
      get: {
        summary: "List research runs",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          "200": {
            description: "Research runs",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResearchRunList" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}": {
      get: {
        summary: "Get a research run",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "200": {
            description: "Research run",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResearchRun" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/report": {
      get: {
        summary: "Get a research run report",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "200": {
            description: "Research run report, null while unavailable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResearchRunReport" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/pulses": {
      get: {
        summary: "List campaign pulses for a research run",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "200": {
            description: "Research run pulses",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResearchRunPulses" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/tasks": {
      get: {
        summary: "List task work units for a research run",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "200": {
            description: "Research run tasks",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResearchRunTasks" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/artifacts": {
      get: {
        summary: "List artifacts for a research run",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "200": {
            description: "Research run artifacts",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResearchArtifacts" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/events": {
      get: {
        summary: "List durable lifecycle events for a research run",
        parameters: [
          { $ref: "#/components/parameters/RunId" },
          {
            name: "after",
            in: "query",
            schema: { type: "integer", minimum: 0 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          "200": {
            description: "Research run events",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResearchEvents" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/actions/pause": {
      post: {
        summary: "Pause a research run",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "200": {
            description: "Research run",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ResearchRun" } },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/actions/resume": {
      post: {
        summary: "Resume a research run",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "202": {
            description: "Resume accepted",
            headers: {
              Location: { schema: { type: "string" } },
              "Retry-After": { schema: { type: "string" } },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ResearchRun" } },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/actions/finalize": {
      post: {
        summary: "Finalize a research run",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "200": {
            description: "Finalized report",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ResearchRunReport" } },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
    "/v1/research-runs/{id}/actions/cancel": {
      post: {
        summary: "Cancel a research run",
        parameters: [{ $ref: "#/components/parameters/RunId" }],
        responses: {
          "200": {
            description: "Cancelled research run",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ResearchRun" } },
            },
          },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
      },
    },
    parameters: {
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 8 },
      },
      RunId: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    },
    responses: {
      Problem: {
        description: "Problem details",
        content: {
          "application/problem+json": {
            schema: { $ref: "#/components/schemas/ProblemDetails" },
          },
        },
      },
    },
    schemas: {
      CreateResearchRunRequest: {
        type: "object",
        required: ["topic"],
        properties: {
          topic: { type: "string", minLength: 1 },
          depth: { type: "string", enum: ["quick", "standard", "deep"] },
          pulseDepth: { type: "string", enum: ["quick", "standard", "deep"] },
          pulseMaxSources: { type: "integer", minimum: 1 },
          mode: { type: "string", enum: ["lookup", "extraction", "synthesis", "survey"] },
          optimizeFor: { $ref: "#/components/schemas/ResearchOptimizationGoal" },
          harness: { $ref: "#/components/schemas/ResearchHarness" },
          selectedHarness: { $ref: "#/components/schemas/ExecutableResearchHarness" },
          clarify: { type: "string" },
          budgets: { $ref: "#/components/schemas/CampaignBudgets" },
          stopWhenGoalMet: { type: "boolean" },
          stopWhenExhaustedSources: { type: "boolean" },
        },
        additionalProperties: false,
      },
      ResearchOptimizationGoal: {
        type: "string",
        enum: ["quality", "latency", "cost", "balanced"],
      },
      ResearchHarness: {
        oneOf: [
          { $ref: "#/components/schemas/AutoHarness" },
          { $ref: "#/components/schemas/SingleAgentHarness" },
          { $ref: "#/components/schemas/CampaignPulsesHarness" },
          { $ref: "#/components/schemas/FixedTeamHarness" },
          { $ref: "#/components/schemas/AsyncSubagentsHarness" },
          { $ref: "#/components/schemas/BlockingSubagentsHarness" },
          { $ref: "#/components/schemas/RedundantFanoutHarness" },
        ],
      },
      ExecutableResearchHarness: {
        oneOf: [
          { $ref: "#/components/schemas/SingleAgentHarness" },
          { $ref: "#/components/schemas/CampaignPulsesHarness" },
          { $ref: "#/components/schemas/FixedTeamHarness" },
          { $ref: "#/components/schemas/AsyncSubagentsHarness" },
          { $ref: "#/components/schemas/BlockingSubagentsHarness" },
          { $ref: "#/components/schemas/RedundantFanoutHarness" },
        ],
      },
      AutoHarness: {
        type: "object",
        required: ["type"],
        properties: { type: { const: "auto" } },
        additionalProperties: false,
      },
      SingleAgentHarness: {
        type: "object",
        required: ["type"],
        properties: { type: { const: "single_agent" } },
        additionalProperties: false,
      },
      CampaignPulsesHarness: {
        type: "object",
        required: ["type"],
        properties: { type: { const: "campaign_pulses" } },
        additionalProperties: false,
      },
      FixedTeamHarness: {
        type: "object",
        required: ["type", "agents"],
        properties: {
          type: { const: "fixed_team" },
          agents: { type: "integer", minimum: 1, default: 5 },
          perAgentTokenLimit: { type: "integer", minimum: 1 },
          totalTokenLimit: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      AsyncSubagentsHarness: {
        type: "object",
        required: ["type", "maxSubagents"],
        properties: {
          type: { const: "async_subagents" },
          maxSubagents: { type: "integer", minimum: 1, default: 5 },
          perSubagentTokenLimit: { type: "integer", minimum: 1 },
          totalTokenLimit: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      BlockingSubagentsHarness: {
        type: "object",
        required: ["type", "maxSubagents"],
        properties: {
          type: { const: "orchestrator_blocking_subagents" },
          maxSubagents: { type: "integer", minimum: 1, default: 5 },
          perSubagentTokenLimit: { type: "integer", minimum: 1 },
          totalTokenLimit: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      RedundantFanoutHarness: {
        type: "object",
        required: ["type", "width"],
        properties: {
          type: { const: "redundant_fanout" },
          width: { type: "integer", minimum: 1, default: 4 },
          perWorkerTokenLimit: { type: "integer", minimum: 1 },
          totalTokenLimit: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      CampaignBudgets: {
        type: "object",
        properties: {
          maxDurationMs: { type: "integer", minimum: 1 },
          maxTokens: { type: "integer", minimum: 1 },
          maxCostUsd: { type: "number", exclusiveMinimum: 0 },
          maxSources: { type: "integer", minimum: 1 },
          finalizationReserveRatio: { type: "number", exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
      CampaignUsage: {
        type: "object",
        required: ["inputTokens", "outputTokens", "cacheReadTokens", "estimatedCostUsd", "sources", "models"],
        properties: {
          inputTokens: { type: "integer" },
          outputTokens: { type: "integer" },
          cacheReadTokens: { type: "integer" },
          estimatedCostUsd: { type: "number" },
          sources: { type: "integer" },
          models: { type: "object", additionalProperties: true },
        },
      },
      ResearchRun: {
        type: "object",
        required: ["id", "kind", "campaignId", "status", "topic", "params", "usage", "createdAt", "updatedAt", "deadlineAt", "stopReason", "links"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["single_agent", "campaign_pulses", "fixed_team", "async_subagents", "orchestrator_blocking_subagents", "redundant_fanout"] },
          campaignId: { type: ["string", "null"] },
          status: { type: "string", enum: ["queued", "running", "paused", "finalizing", "completed", "failed", "cancelled"] },
          topic: { type: "string" },
          params: { $ref: "#/components/schemas/CreateResearchRunRequest" },
          usage: { $ref: "#/components/schemas/CampaignUsage" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          deadlineAt: { type: ["string", "null"], format: "date-time" },
          stopReason: { type: ["string", "null"] },
          links: { $ref: "#/components/schemas/ResearchRunLinks" },
        },
      },
      ResearchRunLinks: {
        type: "object",
        required: ["self", "report", "pulses"],
        properties: {
          self: { type: "string" },
          report: { type: "string" },
          pulses: { type: "string" },
        },
      },
      ResearchRunList: {
        type: "object",
        required: ["data"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/ResearchRun" } },
        },
      },
      ResearchRunReport: {
        type: "object",
        required: ["id", "status", "report", "links"],
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          report: { type: ["string", "null"] },
          links: { $ref: "#/components/schemas/ResearchRunLinks" },
        },
      },
      ResearchRunPulses: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                pulseIndex: { type: "integer" },
                status: { type: "string" },
                objective: { type: "string" },
                taskId: { type: ["string", "null"] },
                decision: { type: ["object", "null"] },
                startedAt: { type: "string", format: "date-time" },
                endedAt: { type: ["string", "null"], format: "date-time" },
              },
            },
          },
        },
      },
      ResearchRunTasks: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/ResearchRunTask" },
          },
        },
      },
      ResearchRunTask: {
        type: "object",
        required: ["id", "runId", "role", "harnessType", "taskId", "queueName", "status", "objective", "usage", "startedAt", "endedAt", "createdAt"],
        properties: {
          id: { type: "string" },
          runId: { type: "string" },
          role: { type: "string" },
          harnessType: { type: "string" },
          taskId: { type: ["string", "null"] },
          queueName: { type: ["string", "null"] },
          status: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled"] },
          objective: { type: "string" },
          usage: { anyOf: [{ $ref: "#/components/schemas/CampaignUsage" }, { type: "null" }] },
          startedAt: { type: ["string", "null"], format: "date-time" },
          endedAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      ResearchArtifacts: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/ResearchArtifact" },
          },
        },
      },
      ResearchArtifact: {
        type: "object",
        required: ["id", "runId", "kind", "contentType", "content", "metadata", "createdAt"],
        properties: {
          id: { type: "integer" },
          runId: { type: "string" },
          kind: { type: "string" },
          contentType: { type: "string" },
          content: { type: "string" },
          metadata: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      ResearchEvents: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/ResearchEvent" },
          },
        },
      },
      ResearchEvent: {
        type: "object",
        required: ["id", "runId", "type", "payload", "createdAt"],
        properties: {
          id: { type: "integer" },
          runId: { type: "string" },
          type: { type: "string" },
          payload: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      ProblemDetails: {
        type: "object",
        required: ["type", "title", "status", "detail"],
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          status: { type: "integer" },
          detail: { type: "string" },
          instance: { type: "string" },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
} as const;
