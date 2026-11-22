import type { OperationEntry } from "@openapi-proxy/core";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import {
  member,
  organization,
  type ProjectRow,
  projectNotifications,
  user,
  variants,
} from "./db/schema";
import { appUrl, type Email, emailConfigured, sendEmail } from "./email";
import type { Env } from "./env";
import { servedKeys } from "./operations";

/** What a check found, operation by operation. */
export interface SourceChanges {
  added: OperationEntry[];
  removed: OperationEntry[];
  /** Still there, but its definition or something it references is different. */
  changed: OperationEntry[];
}

export type NotificationScope = "off" | "served" | "all";

export function isNotificationScope(value: unknown): value is NotificationScope {
  return value === "off" || value === "served" || value === "all";
}

/** Compare two operation lists by key and fingerprint. */
export function diffOperations(before: OperationEntry[], after: OperationEntry[]): SourceChanges {
  const old = new Map(before.map((entry) => [entry.key, entry]));
  const now = new Map(after.map((entry) => [entry.key, entry]));
  return {
    added: after.filter((entry) => !old.has(entry.key)),
    removed: before.filter((entry) => !now.has(entry.key)),
    changed: after.filter((entry) => {
      const previous = old.get(entry.key);
      // A list stored before fingerprints existed has none: nothing to compare.
      return (
        previous?.fingerprint !== undefined &&
        entry.fingerprint !== undefined &&
        previous.fingerprint !== entry.fingerprint
      );
    }),
  };
}

export function hasChanges(changes: SourceChanges): boolean {
  return changes.added.length + changes.removed.length + changes.changed.length > 0;
}

interface Line {
  key: string;
  /** Names of the variants that serve it (or served it, for a removed one). */
  variants: string[];
}

interface Report {
  added: Line[];
  changed: Line[];
  removed: Line[];
}

const MAX_LINES = 25;

function section(title: string, lines: Line[], status: (line: Line) => string): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, MAX_LINES).map((line) => `  ${line.key}: ${status(line)}`);
  const rest = lines.length - shown.length;
  return [
    [`${title} (${lines.length})`, ...shown, ...(rest > 0 ? [`  and ${rest} more`] : [])].join(
      "\n",
    ),
  ];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The email for one person. `served` scope: every new operation (each is a
 * decision waiting to be made), plus changes and removals that touch what a
 * variant serves. `all` scope: everything.
 */
export function changesEmail(input: {
  to: string;
  scope: Exclude<NotificationScope, "off">;
  projectName: string;
  workspaceName: string;
  report: Report;
  projectUrl: string | undefined;
  settingsUrl: string | undefined;
}): Email | undefined {
  const relevant = (lines: Line[]) =>
    input.scope === "all" ? lines : lines.filter((line) => line.variants.length > 0);
  const added = input.report.added;
  const changed = relevant(input.report.changed);
  const removed = relevant(input.report.removed);
  if (added.length + changed.length + removed.length === 0) return undefined;

  const counts = [
    added.length > 0 ? `${added.length} new` : "",
    changed.length > 0 ? `${changed.length} changed` : "",
    removed.length > 0 ? `${removed.length} removed` : "",
  ].filter(Boolean);

  const served = (line: Line) => line.variants.join(", ");
  return {
    to: input.to,
    subject: `${input.projectName}: ${counts.join(", ")}`,
    paragraphs: [
      `The source of ${input.projectName} changed: ${plural(added.length + changed.length + removed.length, "operation")} affected.`,
      ...section("New", added, (line) =>
        line.variants.length > 0 ? `served by ${served(line)}` : "not in any variant yet",
      ),
      ...section("Changed", changed, (line) =>
        line.variants.length > 0 ? `served by ${served(line)}` : "not served",
      ),
      ...section("Removed", removed, (line) =>
        line.variants.length > 0 ? `was served by ${served(line)}` : "was not served",
      ),
      ...(input.projectUrl ? ["Review it here:", input.projectUrl] : []),
    ],
    footer: `You get this as a member of the workspace ${input.workspaceName}.${
      input.settingsUrl ? ` Choose what you are emailed about: ${input.settingsUrl}` : ""
    }`,
  };
}

/**
 * Tell the workspace what changed in a source. Runs after a check that found
 * a different document; `before` is the operation list from before it.
 */
export async function notifyOfChanges(
  db: Db,
  env: Env,
  project: ProjectRow,
  before: OperationEntry[],
  changes: SourceChanges,
  origin?: string,
): Promise<number> {
  if (!emailConfigured(env) || !hasChanges(changes)) return 0;

  // Everyone in the workspace, each with what they chose for this project
  // ("served" until they choose), except those who chose nothing.
  const recipients = await db
    .select({
      email: user.email,
      scope: sql<NotificationScope>`coalesce(${projectNotifications.scope}, 'served')`,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(
      projectNotifications,
      and(
        eq(projectNotifications.userId, member.userId),
        eq(projectNotifications.projectId, project.id),
      ),
    )
    .where(
      and(
        eq(member.organizationId, project.organizationId),
        or(isNull(projectNotifications.scope), ne(projectNotifications.scope, "off")),
      ),
    );
  // The built-in admin has no mailbox.
  const reachable = recipients.filter((recipient) => !recipient.email.endsWith(".local"));
  if (reachable.length === 0) return 0;

  const [workspace, projectVariants] = await Promise.all([
    db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, project.organizationId))
      .get(),
    db
      .select({ name: variants.name, selection: variants.selection })
      .from(variants)
      .where(eq(variants.projectId, project.id)),
  ]);

  const servedNow = projectVariants.map((variant) => ({
    name: variant.name,
    keys: servedKeys(project.opIndex, variant.selection),
  }));
  const servedBefore = projectVariants.map((variant) => ({
    name: variant.name,
    keys: servedKeys(before, variant.selection),
  }));
  const lines = (entries: OperationEntry[], served: typeof servedNow): Line[] =>
    entries.map((entry) => ({
      key: entry.key,
      variants: served.filter((variant) => variant.keys.has(entry.key)).map((v) => v.name),
    }));
  const report: Report = {
    added: lines(changes.added, servedNow),
    changed: lines(changes.changed, servedNow),
    removed: lines(changes.removed, servedBefore),
  };

  const base = appUrl(env, origin);
  let sent = 0;
  for (const recipient of reachable) {
    const email = changesEmail({
      to: recipient.email,
      scope: recipient.scope === "all" ? "all" : "served",
      projectName: project.name,
      workspaceName: workspace?.name ?? "your team",
      report,
      projectUrl: base ? `${base}/p/${project.id}` : undefined,
      settingsUrl: base ? `${base}/workspace` : undefined,
    });
    if (email && (await sendEmail(env, email))) sent += 1;
  }
  return sent;
}
