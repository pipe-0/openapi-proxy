import { sql } from "drizzle-orm";
import { sources } from "./db/schema";

/**
 * How often a project is checked against its sources. Nobody sets this.
 *
 * An OpenAPI document changes when an API is deployed: a few times a day,
 * and nothing reads it by the second. So the question is not how fresh a
 * copy has to be but what a check costs the source. A source that can say
 * "nothing new" without sending its document (through an ETag or a
 * Last-Modified date) is asked often. One that cannot has to generate and
 * send the whole document every time, and is asked rarely. Whoever knows
 * that a deploy just happened has "Check now".
 *
 * Only the timer checks (scheduled.ts). A reader's request never does: what
 * a reader would be steering is how often this service calls somebody else's
 * server.
 */
export const CHECK_EVERY_MS = { cheap: 5 * 60_000, costly: 60 * 60_000 };

/** How often the timer runs. The cron expression in wrangler.jsonc says the same. */
export const TICK_MS = 5 * 60_000;
/**
 * The timer does not fire on the second, and a run takes a while to reach a
 * project. A time this much short of a whole number of ticks lands on the
 * tick it is meant for instead of the one after.
 */
const SLACK_MS = 60_000;

/** In a query on `sources`: whether a check of this source can skip the download. */
export const cheapToCheck = sql<number>`(
  ${sources.upstreamEtag} is not null
  or ${sources.upstreamLastModified} is not null
)`;

/** How long a project's copy may age: as long as its costliest source allows. */
export function checkInterval(cheap: boolean[]): number {
  return cheap.every(Boolean) ? CHECK_EVERY_MS.cheap : CHECK_EVERY_MS.costly;
}

export interface CheckOutcome {
  now: number;
  /** For each source that is checked, whether a check of it can skip the download. */
  cheap: boolean[];
  /** A source did not answer this time. */
  failed: boolean;
  /** One did not answer the time before either. */
  wasFailing: boolean;
}

/**
 * When the timer looks at a project next, or null for never.
 *
 * - Nothing to check: never.
 * - A source just stopped answering: at the next tick, since many failures
 *   are over by then.
 * - It has been failing: at the long interval, so that sources that are gone
 *   do not take the timer's time from the others.
 * - Otherwise: one interval from now.
 */
export function nextCheckAt({ now, cheap, failed, wasFailing }: CheckOutcome): number | null {
  if (cheap.length === 0) return null;
  if (failed) return now + (wasFailing ? CHECK_EVERY_MS.costly : TICK_MS) - SLACK_MS;
  return now + checkInterval(cheap) - SLACK_MS;
}
