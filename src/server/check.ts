import { type RefreshResult, refreshProject } from "./assemble";
import type { Db } from "./db/client";
import type { ProjectRow } from "./db/schema";
import type { Env } from "./env";
import { hasChanges, notifyOfChanges } from "./notify";

export interface CheckOptions {
  /** Skip the version shortcut and look at the document itself. */
  force?: boolean;
  /** The origin of the request that caused the check, for links in emails. */
  origin?: string;
  /** Hand follow-up work to the runtime (`waitUntil`) instead of waiting for it. */
  defer?: (work: Promise<unknown>) => void;
}

/**
 * Compare a project with its source and tell people what changed. Every path
 * that looks at a source goes through here: a reader's request, the hourly
 * run, and "Check now". That is what makes a change get reported exactly
 * once, whoever happens to notice it first.
 */
export async function checkProject(
  db: Db,
  env: Env,
  project: ProjectRow,
  now: number,
  options: CheckOptions = {},
): Promise<RefreshResult> {
  const result = await refreshProject(db, env, project, now, {
    ...(options.force ? { force: true } : {}),
  });

  if (result.changed && hasChanges(result.changes)) {
    const telling = notifyOfChanges(
      db,
      env,
      result.project,
      result.previousOps,
      result.changes,
      options.origin,
    ).catch((error) => {
      console.error("change notification failed", error);
    });
    if (options.defer) options.defer(telling);
    else await telling;
  }
  return result;
}
