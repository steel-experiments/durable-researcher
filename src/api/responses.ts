// ABOUTME: JSON response and RFC 9457 problem-details helpers for the HTTP API.
// ABOUTME: Centralizes response formatting so route handlers stay boring.

import { ResearchServiceError } from "../service/research-errors.js";
import type { ProblemDetails } from "./types.js";

const PROBLEM_BASE = "https://durable-researcher.local/problems";

function titleForCode(code: string): string {
  return code
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function problemResponse(error: unknown, instance?: string): Response {
  const serviceError = error instanceof ResearchServiceError
    ? error
    : new ResearchServiceError("internal_error", error instanceof Error ? error.message : "Unexpected error", 500);
  const body: ProblemDetails = {
    type: `${PROBLEM_BASE}/${serviceError.code}`,
    title: titleForCode(serviceError.code),
    status: serviceError.status,
    detail: serviceError.message,
    instance,
  };
  return jsonResponse(body, {
    status: serviceError.status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

export function methodNotAllowed(allowed: string[]): Response {
  const body: ProblemDetails = {
    type: `${PROBLEM_BASE}/bad_request`,
    title: "Bad Request",
    status: 405,
    detail: "Method not allowed",
  };
  return jsonResponse(body, {
    status: 405,
    headers: {
      Allow: allowed.join(", "),
      "Content-Type": "application/problem+json",
    },
  });
}
