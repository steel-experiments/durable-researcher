// ABOUTME: Versioned HTTP route handlers for durable research runs.
// ABOUTME: Transport glue only: auth, parsing, validation, service calls, responses.

import { requireApiPrincipal } from "./auth.js";
import { OPENAPI_DOCUMENT } from "./openapi.js";
import { jsonResponse, methodNotAllowed, problemResponse } from "./responses.js";
import { parseLimit, parseNonNegativeInteger, validateCreateResearchRunRequest } from "./schemas.js";
import { artifactToResponse, eventToResponse, pulseToResponse, researchRunToResponse, taskToResponse } from "./types.js";
import { badRequest, unsupportedMediaType } from "../service/research-errors.js";
import { createResearchService, type ResearchService } from "../service/research-service.js";

function pathParts(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean);
}

function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get("Content-Type") ?? "";
  return contentType.toLowerCase().startsWith("application/json");
}

async function readJson(request: Request): Promise<unknown> {
  if (!isJsonRequest(request)) {
    throw unsupportedMediaType("Content-Type must be application/json");
  }
  try {
    return await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value) throw badRequest("Idempotency-Key header is required");
  if (value.length < 8) throw badRequest("Idempotency-Key must be at least 8 characters");
  return value;
}

function acceptedRunResponse(run: ReturnType<typeof researchRunToResponse>): Response {
  return jsonResponse(run, {
    status: 202,
    headers: {
      Location: run.links.self,
      "Retry-After": "5",
    },
  });
}

export function createApiHandler(service: ResearchService = createResearchService()) {
  return async function handleApiRequest(request: Request): Promise<Response> {
    try {
      const parts = pathParts(request);
      if (parts[0] !== "v1") {
        return problemResponse(badRequest("Unknown API version"), new URL(request.url).pathname);
      }
      if (parts[1] === "openapi.json" && parts.length === 2) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonResponse(OPENAPI_DOCUMENT);
      }

      const principal = requireApiPrincipal(request);
      const url = new URL(request.url);

      if (parts[1] === "research-runs" && parts.length === 2) {
        if (request.method === "POST") {
          const params = validateCreateResearchRunRequest(await readJson(request));
          const { run } = await service.createRun({
            params,
            ownerId: principal.ownerId,
            idempotencyKey: requireIdempotencyKey(request),
          });
          const responseRun = researchRunToResponse(run);
          void service.startRun(run.id, principal.ownerId).catch(() => undefined);
          return acceptedRunResponse(responseRun);
        }
        if (request.method === "GET") {
          const runs = await service.listRuns(principal.ownerId, parseLimit(url.searchParams.get("limit")));
          return jsonResponse({ data: runs.map(researchRunToResponse) });
        }
        return methodNotAllowed(["GET", "POST"]);
      }

      if (parts[1] === "research-runs" && parts[2] && parts.length === 3) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return jsonResponse(researchRunToResponse(await service.getRun(parts[2], principal.ownerId)));
      }

      if (parts[1] === "research-runs" && parts[2] && parts[3] === "report" && parts.length === 4) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const { run, report } = await service.getReport(parts[2], principal.ownerId);
        return jsonResponse({
          id: run.id,
          status: run.status,
          report,
          links: run.links,
        });
      }

      if (parts[1] === "research-runs" && parts[2] && parts[3] === "pulses" && parts.length === 4) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const pulses = await service.listPulses(parts[2], principal.ownerId);
        return jsonResponse({ data: pulses.map((pulse: any) => "pulseIndex" in pulse ? pulseToResponse(pulse) : taskToResponse(pulse)) });
      }

      if (parts[1] === "research-runs" && parts[2] && parts[3] === "tasks" && parts.length === 4) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const tasks = await service.listTasks(parts[2], principal.ownerId);
        return jsonResponse({ data: tasks.map(taskToResponse) });
      }

      if (parts[1] === "research-runs" && parts[2] && parts[3] === "artifacts" && parts.length === 4) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const artifacts = await service.listArtifacts(parts[2], principal.ownerId);
        return jsonResponse({ data: artifacts.map(artifactToResponse) });
      }

      if (parts[1] === "research-runs" && parts[2] && parts[3] === "events" && parts.length === 4) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const events = await service.listEvents(parts[2], principal.ownerId, {
          afterId: parseNonNegativeInteger(url.searchParams.get("after"), "after"),
          limit: parseLimit(url.searchParams.get("limit")),
        });
        return jsonResponse({ data: events.map(eventToResponse) });
      }

      if (parts[1] === "research-runs" && parts[2] && parts[3] === "actions" && parts[4] && parts.length === 5) {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        if (parts[4] === "pause") {
          return jsonResponse(researchRunToResponse(await service.pauseRun(parts[2], principal.ownerId)));
        }
        if (parts[4] === "resume") {
          const run = await service.resumeRun(parts[2], principal.ownerId);
          return acceptedRunResponse(researchRunToResponse(run));
        }
        if (parts[4] === "finalize") {
          const { run, report } = await service.finalizeRun(parts[2], principal.ownerId);
          return jsonResponse({
            id: run.id,
            status: run.status,
            report,
            links: run.links,
          });
        }
        if (parts[4] === "cancel") {
          return jsonResponse(researchRunToResponse(await service.cancelRun(parts[2], principal.ownerId)));
        }
      }

      return problemResponse(badRequest("Route not found"), url.pathname);
    } catch (err) {
      return problemResponse(err, new URL(request.url).pathname);
    }
  };
}
