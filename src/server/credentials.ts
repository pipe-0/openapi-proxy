import type { StoredHeader } from "./db/schema";
import { ApiError, badRequest } from "./errors";
import { headerProblem, MAX_SOURCE_HEADERS, sealHeaders } from "./secrets";

/** A request header as the app sends it: a name, and a value unless the stored one is kept. */
export interface HeaderInput {
  name: string;
  value?: string;
}

/**
 * Request headers for a followed source, from what was sent: validated, and
 * with new values encrypted. An entry without a value keeps the value that is
 * stored under that name, which is how a header is kept without anyone ever
 * being shown it again.
 */
export async function resolveHeaders(
  input: unknown,
  existing: StoredHeader[],
  secret: string | undefined,
): Promise<StoredHeader[]> {
  if (!Array.isArray(input)) throw badRequest("headers must be a list of { name, value }.");
  if (input.length > MAX_SOURCE_HEADERS) {
    throw badRequest(`At most ${MAX_SOURCE_HEADERS} request headers are supported.`);
  }

  const kept: StoredHeader[] = [];
  const fresh: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();

  for (const entry of input) {
    const { name, value } = (entry ?? {}) as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || (value !== undefined && typeof value !== "string")) {
      throw badRequest("headers must be a list of { name, value }.");
    }
    const trimmed = name.trim();
    const problem = headerProblem(trimmed, value);
    if (problem) throw badRequest(problem);
    if (seen.has(trimmed.toLowerCase())) throw badRequest(`${trimmed} is listed twice.`);
    seen.add(trimmed.toLowerCase());

    if (value === undefined) {
      const stored = existing.find((h) => h.name.toLowerCase() === trimmed.toLowerCase());
      if (!stored) throw badRequest(`A value is required for ${trimmed}.`);
      kept.push(stored);
    } else {
      fresh.push({ name: trimmed, value });
    }
  }

  if (fresh.length === 0) return kept;
  if (!secret) throw new ApiError(503, "not-configured", "AUTH_SECRET is not set.");
  return [...kept, ...(await sealHeaders(secret, fresh))];
}

/** Whether two addresses are on the same origin: stored headers are only ever sent to the one they were entered for. */
export function sameOrigin(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
