import { sql } from "drizzle-orm";
import { projects, sources } from "./db/schema";

/**
 * How often a project is checked against its sources. Nobody sets this.
 *
 * An OpenAPI document changes when an API is deployed: a few times a day,
 * and nothing reads it by the second. So the question is not how fresh a
 * copy has to be but what a check costs the source. A source that can say
 * "nothing new" without sending its document (through a version endpoint, an
 * ETag or a Last-Modified date) is asked often. One that cannot has to
 * generate and send the whole document every time, and is asked rarely.
 * Whoever knows that a deploy just happened, a person or a pipeline, has
 * "Check now".
 *
 * Readers have no say in it. They are anonymous, and what they would be
 * steering is how often this service calls somebody else's server.
 */
export const CHECK_EVERY_MS = { cheap: 5 * 60_000, costly: 60 * 60_000 };

/**
 * How long after a check that failed the next one is made on a reader's
 * request. A source that is failing is not sending its document, so asking
 * costs it little, but the other sources of the project are asked along with
 * it; five minutes is often enough to notice that it is back.
 */
export const RETRY_AFTER_MS = CHECK_EVERY_MS.cheap;

/** In a query on `sources`: whether a check of this source can skip the download. */
export const cheapToCheck = sql<number>`(
  (${sources.versionUrl} is not null and ${sources.versionMismatchAt} is null)
  or ${sources.upstreamEtag} is not null
  or ${sources.upstreamLastModified} is not null
)`;

/**
 * In a query on `projects`: the time between two checks, in milliseconds. A
 * round checks every source of a project, so a project is checked as often
 * as its costliest source allows.
 */
export const checkEveryMs = sql<number>`case when exists (
  select 1 from ${sources}
  where ${sources.projectId} = ${projects.id} and not ${cheapToCheck}
) then ${CHECK_EVERY_MS.costly} else ${CHECK_EVERY_MS.cheap} end`;
