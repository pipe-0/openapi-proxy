import { and, eq, exists, lt, sql } from "drizzle-orm";
import { claimRefresh } from "./assemble";
import { checkProject } from "./check";
import { createDb } from "./db/client";
import { projects, variants } from "./db/schema";
import type { Env } from "./env";
import { isPlatformLimit } from "./upstream";

/** A project nobody has looked at for this long is due. */
const DUE_AFTER_MS = 50 * 60_000;
/** Per run. The stalest go first, so a backlog evens out over the following runs. */
const MAX_PROJECTS_PER_RUN = 40;
const CONCURRENCY = 4;

/**
 * The Worker's cron trigger, hourly. Checks the sources that no reader has
 * caused a check of lately. Without it a change would only be noticed when
 * the next reader comes by, which for a docs build can be days, and the email
 * saying "your API has a new operation that is not in your public docs" would
 * arrive after the build that needed it.
 *
 * Only projects with at least one variant are checked: a source nobody serves
 * anything from has no reader to be current for.
 *
 * Projects are taken in the order they were last looked at, whether that look
 * succeeded or not. Ordering by the last success would put every project with
 * a dead source at the front forever, and enough of them would keep the run
 * from reaching anyone else.
 *
 * A run does as much as the platform lets one invocation do (far less on
 * Cloudflare's free plan than on a paid one) and stops there. What it did not
 * reach is first in line an hour later.
 */
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.DB);
  const now = Date.now();

  // A check that succeeds moves `fetchedAt`; one that fails, or is under way,
  // leaves its claim. The later of the two is when the project was last looked at.
  const lastLookedAt = sql<number>`max(${projects.fetchedAt}, coalesce(${projects.refreshClaimedAt}, 0))`;
  const due = await db
    .select()
    .from(projects)
    .where(
      and(
        lt(lastLookedAt, now - DUE_AFTER_MS),
        exists(
          db.select({ one: sql`1` }).from(variants).where(eq(variants.projectId, projects.id)),
        ),
      ),
    )
    .orderBy(lastLookedAt)
    .limit(MAX_PROJECTS_PER_RUN);

  const queue = [...due];
  const worker = async () => {
    for (let project = queue.shift(); project; project = queue.shift()) {
      try {
        // The claim keeps this from overlapping with a reader's check of the same project.
        if (await claimRefresh(db, project.id, now)) {
          await checkProject(db, env, project, now, { defer: (work) => ctx.waitUntil(work) });
        }
      } catch (error) {
        if (isPlatformLimit(error)) {
          console.warn(`scheduled run stopped at the platform's limit, ${queue.length} left`);
          queue.length = 0;
        } else {
          console.error("scheduled check failed", project.id, error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}
