// plumbing.ts — between a Request and a route, and back again.
//
// Reading the body, turning a result into a Response, and deciding which
// status an error deserves. Nothing here decides anything about places.

import { ValidationError } from "../domain/model";
import type { AuditOutcome } from "../logger";
import { InvalidArgumentError } from "../mcp/mcp";
import { AuthenticationError, AuthorizationError } from "../security/acl";
import { RateLimitError } from "../security/budget";
import { PhotoNotFoundError } from "../storage/photos";
import { ConflictError, NotFoundError } from "../storage/vault";
import type { ApiResult } from "./api";
import { MethodNotAllowedError } from "./routes";

export function statusFor(error: unknown): number {
  if (
    error instanceof AuthenticationError ||
    error instanceof AuthorizationError ||
    error instanceof ValidationError ||
    error instanceof RateLimitError ||
    error instanceof NotFoundError ||
    error instanceof PhotoNotFoundError ||
    error instanceof ConflictError ||
    error instanceof InvalidArgumentError ||
    error instanceof MethodNotAllowedError
  ) {
    return error.status;
  }
  return 500;
}

export function outcomeFor(status: number): AuditOutcome {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "denied";
  return status >= 400 ? "error" : "ok";
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};

  const text = await request.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError("the request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("the request body is not valid JSON");
  }
}

export function toResponse(result: ApiResult): Response {
  const status = result.status ?? 200;
  if (status === 204 || result.body === undefined) {
    return new Response(null, { status, headers: result.headers });
  }
  if (typeof result.body === "string") {
    return new Response(result.body, { status, headers: result.headers });
  }
  return json(result.body, status, result.headers ?? {});
}
