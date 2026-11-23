import { and, asc, eq, exists, lte, sql } from "drizzle-orm";
import { checkProject } from "./check";
import { createDb, type Db } from "./db/client";
import { type ProjectRow, projects, variants } from "./db/schema";
import type { Env } from "./env";
import { TICK_MS } from "./schedule";
import { isPlatformLimit } from "./upstream";

/** Per run. The longest due go first, so a backlog evens out over the following runs. */
const MAX_PROJECTS_PER_RUN = 60;
const CONCURRENCY = 6;
/** No check is started this long into a run: the next run is about to begin. */
const RUN_FOR_MS = TICK_MS - 60_000;
/**
 * A check that finds a new document parses it, which is what costs processor
 * time, and a run that comes round this often gets little of it. After this
 * many, the rest wait for the next run.
 */
const MAX_NEW_DOCUMENTS_PER_RUN = 8;
/** How far ahead a run moves a project when it takes it. A run that dies leaves it due again by then. */
const CLAIM_MS = TICK_MS - 60_000;

/**
 * Take a project for checking, by moving its next check ahead. Of two runs
 * that see the same project as due, one gets the row and the other nothing.
 */
export async function claimDue(
  db: Db,
  projectId: string,
  seen: number,
  now: number,
): Promise<ProjectRow | undefined> {
  const [claimed] = await db
    .update(projects)
    .set({ nextCheckAt: now + CLAIM_MS })
    .where(and(eq(projects.id, projectId), eq(projects.nextCheckAt, seen)))
    .returning();
  return claimed;
}

/**
 * The Worker's cron trigger, every five minutes, and the only thing that
 * checks sources unasked. A request for a variant never does: it reads what
 * is stored.
 *
 * Each project says when it is due (`nextCheckAt`, see schedule.ts). Only
 * projects with at least one variant are checked: a source nobody serves
 * anything from has no reader to be current for.
 *
 * Projects are taken longest due first. A run does as much as the platform
 * lets one invocation do (far less on Cloudflare's free plan than on a paid
 * one) and stops there. What it did not reach is first in line next time.
 */
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.DB);
  const now = Date.now();

  const due = await db
    .select({ id: projects.id, nextCheckAt: projects.nextCheckAt })
    .from(projects)
    .where(
      and(
        lte(projects.nextCheckAt, now),
        exists(
          db.select({ one: sql`1` }).from(variants).where(eq(variants.projectId, projects.id)),
        ),
      ),
    )
    .orderBy(asc(projects.nextCheckAt))
    .limit(MAX_PROJECTS_PER_RUN);

  const queue = [...due];
  let stored = 0;
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (Date.now() - now > RUN_FOR_MS || stored >= MAX_NEW_DOCUMENTS_PER_RUN) {
        queue.length = 0;
        return;
      }
      try {
        const project = await claimDue(db, next.id, next.nextCheckAt as number, now);
        if (!project) continue;
        const result = await checkProject(db, env, project, Date.now(), {
          defer: (work) => ctx.waitUntil(work),
        });
        if (result.changed) stored++;
      } catch (error) {
        if (isPlatformLimit(error)) {
          console.warn(`scheduled run stopped at the platform's limit, ${queue.length} left`);
          queue.length = 0;
        } else {
          console.error("scheduled check failed", next.id, error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}
