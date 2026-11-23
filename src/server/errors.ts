import { DocumentTooComplexError } from "@openapi-proxy/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PLAN_NAMES, type Plan } from "../shared/plans";
import type { AppContext } from "./env";
import { RateLimited, tooManyRequests } from "./rate-limit";
import { UpstreamError } from "./upstream";

/** An error a handler throws to answer with a specific status and machine-readable code. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const notFound = (what: string) => new ApiError(404, "not-found", `${what} not found.`);
export const badRequest = (message: string) => new ApiError(400, "bad-request", message);
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);

/** A request the workspace's plan does not cover. */
export function planLimit(plan: Plan, message: string): ApiError {
  const hint = plan === "pro" ? "" : " Pro lifts this limit.";
  return new ApiError(402, "plan-limit", `${message}${hint}`, { plan, planName: PLAN_NAMES[plan] });
}

/** Every error leaves the API as `{ code, error, detail? }`. */
export function errorResponse(error: unknown, c: Context<AppContext>): Response {
  if (error instanceof ApiError) {
    return c.json({ code: error.code, error: error.message, ...error.extra }, error.status);
  }
  if (error instanceof UpstreamError) {
    return c.json(
      { code: error.code, error: error.message, detail: error.detail },
      error.code === "bad-url" ? 400 : 422,
    );
  }
  if (error instanceof DocumentTooComplexError) {
    return c.json({ code: "too-complex", error: error.message }, 422);
  }
  if (error instanceof RateLimited) return tooManyRequests(c);
  if (error instanceof HTTPException) {
    // Raised by middleware (the CSRF check).
    return c.json({ code: "forbidden", error: "This request was refused." }, error.status);
  }
  console.error(error);
  return c.json({ code: "internal", error: "Something went wrong." }, 500);
}

/** The request body as a JSON object; anything else reads as empty. */
export async function readJson(c: Context<AppContext>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** SQLite reports a lost race for a unique slug or URL like this. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(`${error.message} ${error.cause}`)
  );
}

/** And like this, a row whose parent was deleted while it was on its way. */
export function isMissingParent(error: unknown): boolean {
  return (
    error instanceof Error &&
    /FOREIGN KEY constraint failed/i.test(`${error.message} ${error.cause}`)
  );
}
