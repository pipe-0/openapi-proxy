import {
  assembleDocument,
  ConvertError,
  DocumentTooComplexError,
  fingerprintOperations,
  indexOperations,
  MergeError,
  type OpenAPIDocument,
  type OperationEntry,
  parseSpec,
  sameScheme,
  versionFamily,
  withBudget,
} from "@openapi-proxy/core";
import { and, eq, exists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { GUARDS } from "../shared/plans";
import { sha256Hex, unpack } from "./codec";
import type { Db } from "./db/client";
import { type ProjectNote, type ProjectRow, projects, sources } from "./db/schema";
import type { Env } from "./env";
import { diffOperations, type SourceChanges } from "./notify";
import { cheapToCheck, nextCheckAt } from "./schedule";
import {
  checkSource,
  describeFailure,
  megabytes,
  packSpec,
  type SourceMeta,
  UpstreamError,
} from "./upstream";

/**
 * From a project's sources to its document, and keeping the two in step.
 *
 * A project stores what is true of the assembled document (its operations,
 * its hash); each source stores its own last good copy. A round of checks
 * looks at every source, and if any has a new document, assembles them all
 * again and stores the result in one transaction.
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
    // Everything the assembled document depends on: each source's bytes, and
    // the two settings that change how it is merged in.
    bodyHash: await sha256Hex(
      parts
        .map((part) => [part.bodyHash, part.name, part.pathPrefix ?? ""].join("\n"))
        .join("\n\n"),
    ),
    bodyBytes,
    opIndex,
    notes,
  };
}

/** A stored source with its document parsed, ready to be assembled with others. */
export type StoredPart = SourceDocument & { id: string; position: number; url: string };

/** Every source of a project, parsed, in order. */
export async function storedParts(db: Db, projectId: string): Promise<StoredPart[]> {
  const rows = await db
    .select({
      id: sources.id,
      position: sources.position,
      url: sources.url,
      name: sources.name,
      pathPrefix: sources.pathPrefix,
      bodyHash: sources.bodyHash,
      bodyBytes: sources.bodyBytes,
      body: sources.body,
    })
    .from(sources)
    .where(eq(sources.projectId, projectId))
    .orderBy(sources.position);
  return Promise.all(
    rows.map(async ({ body, ...rest }) => ({ ...rest, doc: parseSpec(await unpack(body)).doc })),
  );
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

/** Every column of a source except its document. */
export const sourceMeta = {
  id: sources.id,
  projectId: sources.projectId,
  position: sources.position,
  name: sources.name,
  url: sources.url,
  headers: sources.headers,
  pathPrefix: sources.pathPrefix,
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
export type SourceInfo = SourceMeta & { cheap: number };

/** A project's sources in order, without their documents. */
export function sourcesOf(db: Db, projectId: string): Promise<SourceInfo[]> {
  return db
    .select(sourceMeta)
    .from(sources)
    .where(eq(sources.projectId, projectId))
    .orderBy(sources.position);
}

/**
 * "The project is at this hash", as a condition for a statement. A project's
 * hash covers everything its document is assembled from, so it moves with
 * every change to its sources. Whoever works something out from a project
 * (a check, an edit) writes only while the project is still at the hash they
 * read: see `refreshProject` here and `editSources` in routes/projects.ts.
 */
export const projectAt = (db: Db, projectId: string, bodyHash: string) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.bodyHash, bodyHash))),
  );

/**
 * Bring a project up to date with its sources. Every source is checked (see
 * `checkSource`); if any has a new document, the project's document is
 * assembled again.
 *
 * A source that fails keeps its last good copy and the project keeps being
 * served; the failure is recorded, and the next check comes sooner or later
 * depending on how long it has been failing (schedule.ts).
 *
 * Everything this writes is conditional on the project still being as it was
 * found. Of two checks that overlap, exactly one stores and reports. A check
 * that overlaps with an edit to the sources writes nothing at all: what it
 * saw is no longer what the project is made of.
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

  const metas = await sourcesOf(db, project.id);
  const checks = await Promise.all(metas.map((source) => checkSource(env, source, now)));

  const failures: string[] = [];
  metas.forEach((source, i) => {
    const check = checks[i];
    if (check?.outcome === "failed") {
      failures.push(metas.length > 1 ? `${source.name}: ${check.error}` : check.error);
    }
  });
  // Whether each source can be checked without a download, as of this check:
  // the validators a source sends can appear and disappear.
  const cheap = metas.map((source, i) => {
    const check = checks[i];
    const seen = check && check.outcome !== "failed" ? check.fields : {};
    const etag = "upstreamEtag" in seen ? seen.upstreamEtag : source.upstreamEtag;
    const modified =
      "upstreamLastModified" in seen ? seen.upstreamLastModified : source.upstreamLastModified;
    return Boolean(etag || modified);
  });
  const status = (problems: string[]) => {
    const failed = problems.length > 0;
    const next = nextCheckAt({ now, cheap, failed, wasFailing: project.lastStatus === "error" });
    return failed
      ? { lastStatus: "error" as const, lastError: problems.join(" "), nextCheckAt: next }
      : { fetchedAt: now, lastStatus: "ok" as const, lastError: null, nextCheckAt: next };
  };

  const found = and(eq(projects.id, project.id), eq(projects.bodyHash, project.bodyHash));
  /** What to record on each source that has no new document, once the project is at `hash`. */
  const bookkeeping = (hash: string) =>
    metas.flatMap((source, i) => {
      const check = checks[i];
      if (!check || check.outcome === "new") return [];
      const fields =
        check.outcome === "same"
          ? check.fields
          : { lastStatus: "error" as const, lastError: check.error };
      return [
        db
          .update(sources)
          .set(fields)
          .where(and(eq(sources.id, source.id), projectAt(db, project.id, hash))),
      ];
    });
  /** The project's own write first, so its row comes back first; then the rest, in one transaction. */
  const write = async <T extends BatchItem<"sqlite">>(first: T, rest: BatchItem<"sqlite">[]) => {
    const [rows] = await db.batch([first, ...rest] as [T, ...BatchItem<"sqlite">[]]);
    return (rows as ProjectRow[])[0];
  };
  const settle = async (problems: string[]) => {
    const updated = await write(
      db.update(projects).set(status(problems)).where(found).returning(),
      bookkeeping(project.bodyHash),
    );
    return updated ? unchanged(updated) : superseded();
  };

  if (!checks.some((check) => check.outcome === "new")) return settle(failures);

  const arrivals = metas.flatMap((source, i) => {
    const check = checks[i];
    return check?.outcome === "new" ? [{ source, check }] : [];
  });
  let assembled: Assembled;
  let bodies: string[];
  let previousOps = project.opIndex;
  try {
    // Every source's document: the new one where there is one, the stored one otherwise.
    const stored = new Map(
      (
        await db
          .select({ id: sources.id, body: sources.body })
          .from(sources)
          .where(eq(sources.projectId, project.id))
      ).map((row) => [row.id, row.body]),
    );
    const parts = await Promise.all(
      metas.map(async (source, i): Promise<SourceDocument> => {
        const check = checks[i];
        if (check?.outcome === "new") {
          const { bodyHash, bodyBytes, doc } = check.fetched;
          return { name: source.name, pathPrefix: source.pathPrefix, bodyHash, bodyBytes, doc };
        }
        // A source that is no longer there was removed while it was being
        // checked. That fails here, and `settle` then finds the project changed.
        const { doc } = parseSpec(await unpack(stored.get(source.id) ?? ""));
        return { ...source, doc };
      }),
    );
    assembled = await assembleProject(parts);
    // Compress first, then build the statements: a query is a thenable, and
    // handing one to a promise would run it on the spot, outside the batch.
    bodies = await Promise.all(arrivals.map(({ check }) => packSpec(check.fetched.body)));
    // Fingerprints say something about each other only if they were computed
    // the same way, which an upgrade of the engine can change. The documents
    // the stored ones were made from are still here, so they are made again,
    // and a change that arrives with an upgrade is reported like any other.
    if (!comparable(project.opIndex, assembled.opIndex)) {
      try {
        const before = await assembleProject(
          await Promise.all(
            metas.map(async (source) => ({
              ...source,
              doc: parseSpec(await unpack(stored.get(source.id) ?? "")).doc,
            })),
          ),
        );
        previousOps = before.opIndex;
      } catch {
        // If the old documents cannot be read that way any more, what was
        // added and removed is still known; what changed is not.
        previousOps = project.opIndex.map(({ fingerprint: _incomparable, ...entry }) => entry);
      }
    }
  } catch (error) {
    // The new documents cannot be put together, or stored. Nothing of them is kept.
    return settle([...failures, describeFailure(error)]);
  }

  // One transaction: the hash that feeds every ETag and the documents it
  // describes move together.
  const arrived = projectAt(db, project.id, assembled.bodyHash);
  const fresh = arrivals.map(({ source, check }, i) =>
    db
      .update(sources)
      .set({ ...check.fields, body: bodies[i] as string })
      .where(and(eq(sources.id, source.id), arrived)),
  );
  const updated = await write(
    db
      .update(projects)
      .set({ ...status(failures), ...assembled })
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
