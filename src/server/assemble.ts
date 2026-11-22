import {
  assembleDocument,
  ConvertError,
  fingerprintOperations,
  indexOperations,
  MergeError,
  type OpenAPIDocument,
  type OperationEntry,
  parseSpec,
  versionFamily,
} from "@openapi-proxy/core";
import { and, eq, exists, isNull, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { GUARDS } from "../shared/plans";
import { sha256Hex, unpack } from "./codec";
import type { Db } from "./db/client";
import { type ProjectNote, type ProjectRow, projects, type SourceRow, sources } from "./db/schema";
import type { Env } from "./env";
import { diffOperations, type SourceChanges } from "./notify";
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
  try {
    assembled = assembleDocument(
      parts.map((part) => ({
        name: part.name,
        doc: part.doc,
        pathPrefix: part.pathPrefix ?? undefined,
      })),
    );
  } catch (error) {
    if (error instanceof MergeError || error instanceof ConvertError) {
      throw new UpstreamError("cannot-merge", error.message);
    }
    throw error;
  }

  const fingerprints = fingerprintOperations(assembled.doc);
  const several = parts.length > 1;
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
    opIndex: indexOperations(assembled.doc).entries.map((entry) => ({
      ...entry,
      fingerprint: fingerprints.get(entry.key),
      ...(several ? { source: assembled.origins.get(entry.key) } : {}),
    })),
    notes: [
      ...assembled.converted.map((converted) => ({
        kind: "source-converted" as const,
        ...converted,
      })),
      ...assembled.notes,
    ],
  };
}

/** The assembled document itself, for rendering and for the editor's preview. */
export async function loadDocument(
  rows: Array<Pick<SourceRow, "name" | "pathPrefix" | "body">>,
): Promise<{
  doc: OpenAPIDocument;
  /** How the main source indents its JSON, for output that looks like it. */
  indent: ReturnType<typeof parseSpec>["indent"];
  /** With one source served as it is: its own text, which is the document. */
  single: string | undefined;
}> {
  const parsed = await Promise.all(
    rows.map(async (row) => {
      const text = await unpack(row.body);
      return { row, text, spec: parseSpec(text) };
    }),
  );
  const [first] = parsed;
  if (!first) throw new Error("A project without sources.");
  const { doc } = assembleDocument(
    parsed.map(({ row, spec }) => ({
      name: row.name,
      doc: spec.doc,
      pathPrefix: row.pathPrefix ?? undefined,
    })),
  );
  return {
    doc,
    indent: first.spec.indent,
    single: parsed.length === 1 && !first.row.pathPrefix ? first.text : undefined,
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
  versionUrl: sources.versionUrl,
  lastKnownVersion: sources.lastKnownVersion,
  versionMismatchAt: sources.versionMismatchAt,
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
};

/** A project's sources in order, without their documents. */
export function sourcesOf(db: Db, projectId: string): Promise<SourceMeta[]> {
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
 * served; the failure is recorded and retried after a pause.
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
  options: { force?: boolean } = {},
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
  const checks = await Promise.all(metas.map((source) => checkSource(env, source, now, options)));

  const failures: string[] = [];
  metas.forEach((source, i) => {
    const check = checks[i];
    if (check?.outcome === "failed") {
      failures.push(metas.length > 1 ? `${source.name}: ${check.error}` : check.error);
    }
  });
  // Every source answered: the interval starts over. Otherwise the claim stays,
  // which is what spaces out the retries.
  const status = (problems: string[]) =>
    problems.length === 0
      ? { fetchedAt: now, refreshClaimedAt: null, lastStatus: "ok" as const, lastError: null }
      : { lastStatus: "error" as const, lastError: problems.join(" "), refreshClaimedAt: now };

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

  let assembled: Assembled;
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
  } catch (error) {
    // The new documents cannot be put together. Nothing of them is stored.
    return settle([...failures, describeFailure(error)]);
  }

  // One transaction: the hash that feeds every ETag and the documents it
  // describes move together.
  const arrived = projectAt(db, project.id, assembled.bodyHash);
  // Compress first, then build the statements: a query is a thenable, and
  // handing one to a promise would run it on the spot, outside the batch.
  const arrivals = metas.flatMap((source, i) => {
    const check = checks[i];
    return check?.outcome === "new" ? [{ source, check }] : [];
  });
  const bodies = await Promise.all(arrivals.map(({ check }) => packSpec(check.fetched.body)));
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

  const changes = diffOperations(project.opIndex, assembled.opIndex);
  return {
    changed: true,
    addedOps: changes.added.map((entry) => entry.key),
    removedOps: changes.removed.map((entry) => entry.key),
    changedOps: changes.changed.map((entry) => entry.key),
    changes,
    previousOps: project.opIndex,
    project: updated,
  };
}

/**
 * Take the right to check a project against its sources. Many requests can
 * notice a stale project at once; exactly one of them wins the claim and
 * talks to the sources. The claim expires on its own, so a crashed check
 * cannot block later ones, and a failed one is not retried before it expires.
 */
export async function claimRefresh(db: Db, projectId: string, now: number): Promise<boolean> {
  const claimed = await db
    .update(projects)
    .set({ refreshClaimedAt: now })
    .where(
      and(
        eq(projects.id, projectId),
        or(
          isNull(projects.refreshClaimedAt),
          lte(projects.refreshClaimedAt, now - REFRESH_CLAIM_MS),
        ),
      ),
    )
    .returning({ id: projects.id });
  return claimed.length > 0;
}

/** How long one check holds its claim, and how long a failed one waits before the next try. */
export const REFRESH_CLAIM_MS = 30_000;
