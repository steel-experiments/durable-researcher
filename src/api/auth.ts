// ABOUTME: Bearer-token auth helper for the HTTP API.
// ABOUTME: Defaults to local development openness while requiring auth in production.

import { unauthorized } from "../service/research-errors.js";

export type ApiPrincipal = {
  ownerId: string;
};

export function requireApiPrincipal(request: Request): ApiPrincipal {
  const expected = process.env.DURABLE_RESEARCHER_API_KEY;
  if (!expected && process.env.NODE_ENV !== "production") {
    return { ownerId: "default" };
  }
  if (!expected) throw unauthorized("DURABLE_RESEARCHER_API_KEY is required in production");

  const auth = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix) || auth.slice(prefix.length) !== expected) {
    throw unauthorized();
  }
  return { ownerId: "default" };
}
