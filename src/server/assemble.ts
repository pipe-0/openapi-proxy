import {
  assembleDocument,
  ConvertError,
  DocumentTooComplexError,
  fingerprintOperations,
  indexOperations,
  MergeError,
  type OpenAPIDocument,
  type OperationEntry,
  type ProjectNote,
  parseSpec,
  sameScheme,
  UNNAMED_SOURCE,
  versionFamily,
  withBudget,
} from "@openapi-proxy/core";
import { and, eq, exists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { GUARDS } from "../shared/plans";
import { sha256Hex, unpack } from "./codec";
import type { Db } from "./db/client";
import { type ProjectRow, projects, type SourceRow, sources } from "./db/schema";
import type { Env } from "./env";
import { diffOperations, type SourceChanges } from "./notify";
import { cheapToCheck, nextCheckAt } from "./schedule";
import {
  checkSource,
  describeFailure,
  megabytes,
  packSpec,
  type SourceCheck,
  UpstreamError,
} from "./upstream";

/**
 * From a project's sources to its document, and keeping the two in step.
 *
 * A project stores what is true of the assembled document (its operations,
 * its hash); each source stores its own copy. A document gets there in one of
 * two ways. It is uploaded with an apply (apply.ts), and then changes only
 * with the next one. Or its source is followed, and a round of checks looks
 * at it here: if any followed source has a new document, all of the project's
 * are assembled again and the result is stored in one transaction.
 */

export const MAX_SOURCES_PER_PROJECT = GUARDS.sourcesPerProject;
/** What merging did is kept for the owner to read, up to this many notes. */
const MAX_NOTES = 200;
/** D1 rows hold 2 MB. The operation index shares its row with little else. */
const MAX_INDEX_LENGTH = 1_500_000;

/** Whether two operation lists carry fingerprints that were computed the same way. */
function comparable(before: OperationEntry[], after: OperationEntry[]): boolean {
  const [old] = before.flatMap((entry) => entry.fingerprint ?? []);
  const [now] = after.flatMap((entry) => entry.fingerprint ?? []);
  return old === undefined || now === undefined || sameScheme(old, now);
}

/** The sources of a project together. The whole document is in memory when it is served. */
export const MAX_PROJECT_BYTES = GUARDS.projectBytes;

/** One source, ready to be assembled. */
export interface SourceDocument {
  name: string;
  pathPrefix: string | null;
  bodyHash: string;
  bodyBytes: number;
  doc: OpenAPIDocument;
}

/** What assembling a project's sources produced: the facts stored on the project. */
export interface Assembled {
  specVersion: string;
  bodyHash: string;
  bodyBytes: number;
  opIndex: OperationEntry[];
  notes: ProjectNote[];
}

/**
 * The hash of a project's document, from what it depends on: each source's
 * bytes in merge order, and the two settings that change how a source is
 * merged in. It can be worked out without the documents, which is how an
 * apply knows whether anything has to be assembled at all.
 */
export function projectHash(
  parts: Array<Pick<SourceDocument, "bodyHash" | "name" | "pathPrefix">>,
): Promise<string> {
  return sha256Hex(
    parts.map((part) => [part.bodyHash, part.name, part.pathPrefix ?? ""].join("\n")).join("\n\n"),
  );
}

export async function assembleProject(parts: SourceDocument[]): Promise<Assembled> {
  const bodyBytes = parts.reduce((sum, part) => sum + part.bodyBytes, 0);
  if (bodyBytes > MAX_PROJECT_BYTES) {
    throw new UpstreamError(
      "too-large",
      parts.length === 1
        ? `The source is larger than the ${megabytes(MAX_PROJECT_BYTES)} limit.`
        : `The sources are ${megabytes(bodyBytes)} together. The limit for one project is ${megabytes(MAX_PROJECT_BYTES)}.`,
    );
  }

  let assembled: ReturnType<typeof assembleDocument>;
  let opIndex: OperationEntry[];
  try {
    // One budget of work for all of it (see `withBudget` in the engine).
    ({ assembled, opIndex } = withBudget(() => {
      const assembled = assembleDocument(
        parts.map((part) => ({
          name: part.name,
          doc: part.doc,
          pathPrefix: part.pathPrefix ?? undefined,
        })),
      );
      const fingerprints = fingerprintOperations(assembled.doc);
      const several = parts.length > 1;
      const opIndex = indexOperations(assembled.doc).entries.map((entry) => ({
        ...entry,
        fingerprint: fingerprints.get(entry.key),
        ...(several ? { source: assembled.origins.get(entry.key) } : {}),
      }));
      return { assembled, opIndex };
    }));
  } catch (error) {
    if (error instanceof MergeError || error instanceof ConvertError) {
      throw new UpstreamError("cannot-merge", error.message);
    }
    // Each source fits; together they are more than can be worked on.
    if (error instanceof DocumentTooComplexError)
      throw new UpstreamError("too-large", error.message);
    throw error;
  }

  // The index and the notes are stored on the project's row, and a row has a
  // size. A document with more operations than fit is not one this can keep.
  const notes = [
    ...assembled.converted.map((converted) => ({
      kind: "source-converted" as const,
      ...converted,
    })),
    ...assembled.notes,
  ].slice(0, MAX_NOTES);
  if (JSON.stringify(opIndex).length + JSON.stringify(notes).length > MAX_INDEX_LENGTH) {
    throw new UpstreamError(
      "too-large",
      `The document has ${opIndex.length.toLocaleString("en-US")} operations, which is more than an index can be kept for.`,
    );
  }
  return {
    specVersion: versionFamily(assembled.doc),
    bodyHash: await projectHash(parts),
    bodyBytes,
    opIndex,
    notes,
  };
}

/** Every column of a source except its document. */
export const sourceMeta = {
  id: sources.id,
  projectId: sources.projectId,
  position: sources.position,
  name: sources.name,
  url: sources.url,
  file: sources.file,
  follow: sources.follow,
  main: sources.main,
  pathPrefix: sources.pathPrefix,
  headers: sources.headers,
  title: sources.title,
  apiVersion: sources.apiVersion,
  specVersion: sources.specVersion,
  upstreamEtag: sources.upstreamEtag,
  upstreamLastModified: sources.upstreamLastModified,
  bodyHash: sources.bodyHash,
  bodyBytes: sources.bodyBytes,
  operations: sources.operations,
  verifiedAt: sources.verifiedAt,
  lastStatus: sources.lastStatus,
  lastError: sources.lastError,
  /** Whether a check can skip the download (schedule.ts). 1 or 0. */
  cheap: cheapToCheck,
};

/** A source as read from the database: everything but its document. */
export type SourceInfo = Omit<SourceRow, "body"> & { cheap: number };

/** A project's sources as the definition lists them, without their documents. */
export function sourcesOf(db: Db, projectId: string): Promise<SourceInfo[]> {
  return db
    .select(sourceMeta)
    .from(sources)
    .where(eq(sources.projectId, projectId))
    .orderBy(sources.position);
}

/** What a source goes by: its name, or the one a project's only unnamed source has. */
export const labelOf = (source: { name: string | null }): string => source.name ?? UNNAMED_SOURCE;

/**
 * Sources in the order they are merged: the main one first, then the others
 * as listed. Where two define the same operation, the earlier wins.
 */
export function inMergeOrder<T extends { main: boolean; position: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.main) - Number(a.main) || a.position - b.position);
}

/** The stored document of each source of a project, by source id, still packed. */
export async function storedBodies(db: Db, projectId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: sources.id, body: sources.body })
    .from(sources)
    .where(eq(sources.projectId, projectId));
  return new Map(rows.map((row) => [row.id, row.body]));
}

/** A stored document, parsed. */
export const parseStored = async (packed: string): Promise<OpenAPIDocument> =>
  parseSpec(await unpack(packed)).doc;

/**
 * The operation list to compare a new one with. Fingerprints say something
 * about each other only if they were computed the same way, which an upgrade
 * of the engine can change. The documents the stored ones were made from are
 * still there, so they are made again, and a change that arrives with an
 * upgrade is reported like any other.
 */
export async function previousOperations(
  stored: OperationEntry[],
  next: OperationEntry[],
  storedParts: () => Promise<SourceDocument[]>,
): Promise<OperationEntry[]> {
  if (comparable(stored, next)) return stored;
  try {
    return (await assembleProject(await storedParts())).opIndex;
  } catch {
    // If the old documents cannot be read that way any more, what was added
    // and removed is still known; what changed is not.
    return stored.map(({ fingerprint: _incomparable, ...entry }) => entry);
  }
}

export interface RefreshResult {
  /** The assembled document is different from the stored one, and this call stored it. */
  changed: boolean;
  addedOps: string[];
  removedOps: string[];
  /** Operations that are still there with a different definition. */
  changedOps: string[];
  /** The same three, with their details, for whoever reports them. */
  changes: SourceChanges;
  /** The operation list from before this call. */
  previousOps: OperationEntry[];
  project: ProjectRow;
}

const NO_CHANGES: SourceChanges = { added: [], removed: [], changed: [] };

/**
 * "The project is as it was read", as a condition for a statement. Two things
 * say what a project is made of: its revision, which counts the definitions
 * applied to it, and the hash of its documents, which a check moves when it
 * stores a new one. Whoever works something out from a project (a check, an
 * apply) writes only while both are what they read.
 */
export const projectAt = (db: Db, projectId: string, revision: number, bodyHash?: string) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.revision, revision),
          bodyHash === undefined ? undefined : eq(projects.bodyHash, bodyHash),
        ),
      ),
  );

/**
 * Bring a project up to date with the sources it follows. Each is checked
 * (see `checkSource`); if any has a new document, the project's document is
 * assembled again, from the new documents and the stored copies of all the
 * others, followed or not.
 *
 * A source that fails keeps its last good copy and the project keeps being
 * served; the failure is recorded, and the next check comes sooner or later
 * depending on how long it has been failing (schedule.ts).
 *
 * Everything this writes is conditional on the project still being as it was
 * found. Of two checks that overlap, exactly one stores and reports. A check
 * that overlaps with an apply writes nothing at all: what it saw is no longer
 * what the project is made of.
 */
export async function refreshProject(
  db: Db,
  env: Env,
  project: ProjectRow,
  now: number,
): Promise<RefreshResult> {
  const unchanged = (current: ProjectRow): RefreshResult => ({
    changed: false,
    addedOps: [],
    removedOps: [],
    changedOps: [],
    changes: NO_CHANGES,
    previousOps: project.opIndex,
    project: current,
  });
  /** Someone else wrote first. The answer is the project as it is now. */
  const superseded = async (): Promise<RefreshResult> => {
    const current = await db.select().from(projects).where(eq(projects.id, project.id)).get();
    if (!current) throw new Error("The project was deleted during the check.");
    return unchanged(current);
  };

  const all = await sourcesOf(db, project.id);
  const followed = all.filter((source) => source.follow && source.url !== null);
  const found = and(
    eq(projects.id, project.id),
    eq(projects.revision, project.revision),
    eq(projects.bodyHash, project.bodyHash),
  );
  if (followed.length === 0) {
    // Nothing to look at: its documents arrive with an apply.
    const [settled] = await db
      .update(projects)
      .set({ nextCheckAt: null, watchUntil: null })
      .where(found)
      .returning();
    return settled ? unchanged(settled) : superseded();
  }

  const checks = new Map<string, SourceCheck>();
  await Promise.all(
    followed.map(async (source) => {
      checks.set(source.id, await checkSource(env, { ...source, url: source.url as string }, now));
    }),
  );

  const failures: string[] = [];
  for (const source of followed) {
    const check = checks.get(source.id);
    if (check?.outcome === "failed") {
      failures.push(all.length > 1 ? `${labelOf(source)}: ${check.error}` : check.error);
    }
  }
  // Whether each followed source can be checked without a download, as of
  // this check: the validators a source sends can appear and disappear.
  const cheap = followed.map((source) => {
    const check = checks.get(source.id);
    const seen = check && check.outcome !== "failed" ? check.fields : {};
    const etag = "upstreamEtag" in seen ? seen.upstreamEtag : source.upstreamEtag;
    const modified =
      "upstreamLastModified" in seen ? seen.upstreamLastModified : source.upstreamLastModified;
    return Boolean(etag || modified);
  });
  const status = (problems: string[], watchUntil: number | null) => {
    const failed = problems.length > 0;
    const next = nextCheckAt({
      now,
      cheap,
      failed,
      wasFailing: project.lastStatus === "error",
      watchUntil,
    });
    return failed
      ? { lastStatus: "error" as const, lastError: problems.join(" "), nextCheckAt: next }
      : { checkedAt: now, lastStatus: "ok" as const, lastError: null, nextCheckAt: next };
  };

  /** What to record on each followed source that has no new document, once the project has the documents `bodyHash`. */
  const bookkeeping = (bodyHash: string) =>
    followed.flatMap((source) => {
      const check = checks.get(source.id);
      if (!check || check.outcome === "new") return [];
      const fields =
        check.outcome === "same"
          ? check.fields
          : { lastStatus: "error" as const, lastError: check.error };
      return [
        db
          .update(sources)
          .set(fields)
          .where(
            and(eq(sources.id, source.id), projectAt(db, project.id, project.revision, bodyHash)),
          ),
      ];
    });
  /** The project's own write first, so its row comes back first; then the rest, in one transaction. */
  const write = async <T extends BatchItem<"sqlite">>(first: T, rest: BatchItem<"sqlite">[]) => {
    const [rows] = await db.batch([first, ...rest] as [T, ...BatchItem<"sqlite">[]]);
    return (rows as ProjectRow[])[0];
  };
  const settle = async (problems: string[]) => {
    const updated = await write(
      db.update(projects).set(status(problems, project.watchUntil)).where(found).returning(),
      bookkeeping(project.bodyHash),
    );
    return updated ? unchanged(updated) : superseded();
  };

  const arrivals = followed.flatMap((source) => {
    const check = checks.get(source.id);
    return check?.outcome === "new" ? [{ source, check }] : [];
  });
  if (arrivals.length === 0) return settle(failures);

  let assembled: Assembled;
  let bodies: string[];
  let previousOps = project.opIndex;
  try {
    // Every source's document: the new one where there is one, the stored one otherwise.
    const stored = await storedBodies(db, project.id);
    const ordered = inMergeOrder(all);
    const partOf = async (source: SourceInfo, fresh: boolean): Promise<SourceDocument> => {
      const check = checks.get(source.id);
      const base = { name: labelOf(source), pathPrefix: source.pathPrefix };
      if (fresh && check?.outcome === "new") {
        const { bodyHash, bodyBytes, doc } = check.fetched;
        return { ...base, bodyHash, bodyBytes, doc };
      }
      // A source that is no longer there was removed while it was being
      // checked. That fails here, and `settle` then finds the project changed.
      return {
        ...base,
        bodyHash: source.bodyHash,
        bodyBytes: source.bodyBytes,
        doc: await parseStored(stored.get(source.id) ?? ""),
      };
    };
    assembled = await assembleProject(await Promise.all(ordered.map((s) => partOf(s, true))));
    // Compress first, then build the statements: a query is a thenable, and
    // handing one to a promise would run it on the spot, outside the batch.
    bodies = await Promise.all(arrivals.map(({ check }) => packSpec(check.fetched.body)));
    previousOps = await previousOperations(project.opIndex, assembled.opIndex, () =>
      Promise.all(ordered.map((s) => partOf(s, false))),
    );
  } catch (error) {
    // The new documents cannot be put together, or stored. Nothing of them is kept.
    return settle([...failures, describeFailure(error)]);
  }

  // One transaction: the hash that feeds every ETag and the documents it
  // describes move together. A new document is what a deploy was waiting for,
  // so the watch it asked for ends here.
  const arrived = projectAt(db, project.id, project.revision, assembled.bodyHash);
  const fresh = arrivals.map(({ source, check }, i) =>
    db
      .update(sources)
      .set({ ...check.fields, title: check.fetched.title, body: bodies[i] as string })
      .where(and(eq(sources.id, source.id), arrived)),
  );
  const updated = await write(
    db
      .update(projects)
      .set({ ...status(failures, null), ...assembled, watchUntil: null })
      .where(found)
      .returning(),
    [...fresh, ...bookkeeping(assembled.bodyHash)],
  );
  if (!updated) return superseded();

  const changes = diffOperations(previousOps, assembled.opIndex);
  return {
    changed: true,
    addedOps: changes.added.map((entry) => entry.key),
    removedOps: changes.removed.map((entry) => entry.key),
    changedOps: changes.changed.map((entry) => entry.key),
    changes,
    previousOps,
    project: updated,
  };
}
