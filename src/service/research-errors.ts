// ABOUTME: Typed service errors that API transports can map to stable HTTP problems.
// ABOUTME: Keeps application failure modes explicit without coupling the core to HTTP.

export type ServiceErrorCode =
  | "bad_request"
  | "conflict"
  | "not_found"
  | "unauthorized"
  | "internal_error"
  | "unsupported_media_type";

export class ResearchServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ResearchServiceError";
  }
}

export function badRequest(message: string): ResearchServiceError {
  return new ResearchServiceError("bad_request", message, 400);
}

export function conflict(message: string): ResearchServiceError {
  return new ResearchServiceError("conflict", message, 409);
}

export function notFound(message: string): ResearchServiceError {
  return new ResearchServiceError("not_found", message, 404);
}

export function unauthorized(message = "Unauthorized"): ResearchServiceError {
  return new ResearchServiceError("unauthorized", message, 401);
}

export function unsupportedMediaType(message: string): ResearchServiceError {
  return new ResearchServiceError("unsupported_media_type", message, 415);
}
