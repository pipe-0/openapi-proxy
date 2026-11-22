import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppContext, Env } from "./env";

/**
 * How much one workspace may ask of the API.
 *
 * The counting is Cloudflare's: the Workers Rate Limiting binding
 * `API_RATE_LIMIT`, declared in wrangler.jsonc, which is also where the
 * budget per minute is set. This file decides what is counted, for whom, and
 * what a request costs.
 *
 * - The budget belongs to a workspace, not to an address or a key. Ten
 *   keys of one workspace share it, and two workspaces behind one office
 *   address do not.
 * - Every request to the API costs one.
 * - A request that makes this instance fetch a URL the workspace chose costs
 *   ten. That is the one thing a signed-in person can make the instance do to
 *   somebody else's server, so it is the thing to keep scarce.
 *
 * Counts are kept per Cloudflare location and are approximate, which is all a
 * guard against abuse needs. Without the binding (in tests, or on a
 * deployment that removed it) nothing is limited.
 *
 * If the limiter itself fails, ordinary requests go through: a guard should
 * not take the API down with it. The requests that fetch from a source do
 * not. With nothing counting them, the instance would fetch whatever URL it
 * is given as fast as it is asked to, so those wait until the limiter is back.
 */
export const REQUEST_COST = 1;
export const SOURCE_COST = 10;

/**
 * Take `cost` from a workspace's budget. False when the budget is spent, and
 * `ifUnavailable` when the limiter cannot be asked.
 */
export async function spend(
  env: Pick<Env, "API_RATE_LIMIT">,
  organizationId: string,
  cost: number,
  ifUnavailable = true,
): Promise<boolean> {
  if (!env.API_RATE_LIMIT) return true;
  try {
    return (await env.API_RATE_LIMIT.limit({ key: organizationId, delta: cost })).success;
  } catch (error) {
    console.error("rate limiter failed", error);
    return ifUnavailable;
  }
}

export function tooManyRequests(c: Context<AppContext>): Response {
  c.header("retry-after", "60");
  return c.json(
    {
      code: "rate-limited",
      error: "Too many requests from this workspace. Try again in a minute.",
    },
    429,
  );
}

/** Middleware: charge the request to the workspace it acts for. Goes after authentication. */
export const charge = (cost: number, ifUnavailable = true) =>
  createMiddleware<AppContext>(async (c, next) => {
    if (!(await spend(c.env, c.var.organizationId, cost, ifUnavailable))) {
      return tooManyRequests(c);
    }
    await next();
  });

/**
 * For the routes that fetch from a source: what they cost beyond an ordinary
 * request. Refused while the limiter cannot be asked.
 */
export const contactsSource = charge(SOURCE_COST - REQUEST_COST, false);
