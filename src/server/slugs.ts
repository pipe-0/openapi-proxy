import { and, desc, eq, gt, lte, ne, notInArray, or } from "drizzle-orm";
import type { Db } from "./db/client";
import { projects, releasedSlugs } from "./db/schema";

/**
 * Project slugs, which are the first part of every public URL and unique
 * across the deployment.
 *
 * A slug that is given up, by deleting its project, is held for the
 * workspace that had it. Without that, anyone could take it the moment it is
 * free and put a document of their own behind an address that someone's
 * build still fetches.
 */
export const SLUG_HOLD_MS = 90 * 24 * 60 * 60 * 1000;
/** How many slugs one workspace can hold at a time, so that holding cannot be used to squat. */
const MAX_HELD_SLUGS = 10;

/** In a query on `released_slugs`: held for some other workspace, and still within the hold. */
export const heldForOthers = (organizationId: string, now = Date.now()) =>
  and(
    ne(releasedSlugs.organizationId, organizationId),
    gt(releasedSlugs.releasedAt, now - SLUG_HOLD_MS),
  );

/** Whether a workspace may not have a slug: another workspace has it, or it is held for one. */
export async function slugTaken(db: Db, organizationId: string, slug: string): Promise<boolean> {
  const [used, held] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.slug, slug), ne(projects.organizationId, organizationId)))
      .get(),
    db
      .select({ slug: releasedSlugs.slug })
      .from(releasedSlugs)
      .where(and(eq(releasedSlugs.slug, slug), heldForOthers(organizationId)))
      .get(),
  ]);
  return Boolean(used || held);
}

/**
 * Statements that record a slug as given up by a workspace. They belong in
 * the same batch as whatever frees the slug.
 */
export function releaseSlug(db: Db, organizationId: string, slug: string) {
  const now = Date.now();
  const newest = db
    .select({ slug: releasedSlugs.slug })
    .from(releasedSlugs)
    .where(eq(releasedSlugs.organizationId, organizationId))
    .orderBy(desc(releasedSlugs.releasedAt))
    .limit(MAX_HELD_SLUGS);
  return [
    db
      .insert(releasedSlugs)
      .values({ slug, organizationId, releasedAt: now })
      .onConflictDoUpdate({
        target: releasedSlugs.slug,
        set: { organizationId, releasedAt: now },
      }),
    // What has run out, and anything beyond what one workspace may hold.
    db
      .delete(releasedSlugs)
      .where(
        or(
          lte(releasedSlugs.releasedAt, now - SLUG_HOLD_MS),
          and(
            eq(releasedSlugs.organizationId, organizationId),
            notInArray(releasedSlugs.slug, newest),
          ),
        ),
      ),
  ] as const;
}
