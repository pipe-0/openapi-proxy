import { Buffer } from "node:buffer";
import {
  type AppliedRecord,
  type ApplyResult,
  canonicalJson,
  type DocumentInput,
  describeProblem,
  effectiveVariant,
  effectiveVisibility,
  mergeOrder,
  ORIGINAL_VARIANT,
  readDefinition,
  resolveSelection,
  type SourceDefinition,
  type SourceReport,
  servedSlugs,
  sourceLabel,
  unmatchedNames,
  type VariantReport,
  warningsOf,
} from "@openapi-proxy/core";
import { type AnyColumn, and, count, eq, exists, ne, not, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { PLAN_NAMES } from "../shared/plans";
import {
  type Assembled,
  assembleProject,
  inMergeOrder,
  labelOf,
  MAX_PROJECT_BYTES,
  parseStored,
  previousOperations,
  projectHash,
  type SourceDocument,
  type SourceInfo,
  sourcesOf,
  storedBodies,
} from "./assemble";
import { sha256Hex } from "./codec";
import { resolveHeaders, sameOrigin } from "./credentials";
import type { Db } from "./db/client";
import {
  apiKeys,
  organization,
  type ProjectRow,
  projects,
  releasedSlugs,
  type StoredHeader,
  sources,
  type VariantRow,
  variants,
} from "./db/schema";
import { sourceColumns, variantColumns } from "./definition-rows";
import type { Env } from "./env";
import { ApiError, badRequest, isMissingParent, isUniqueViolation, planLimit } from "./errors";
import { newId, randomToken } from "./id";
import { diffOperations, hasChanges, notifyOfChanges, type SourceChanges } from "./notify";
import { asIndex } from "./operations";
import { planOf } from "./plans";
import { nextCheckAt, WATCH_MS } from "./schedule";
import { openHeaders } from "./secrets";
import { heldForOthers, slugTaken } from "./slugs";
import {
  type FetchedSpec,
  fetchSpec,
  type InspectedSpec,
  inspectDocument,
  megabytes,
  packSpec,
  UpstreamError,
} from "./upstream";

/**
 * Applying a definition: the one way a project comes to be and changes. The
 * app's editor, `openapi-proxy deploy` and anything else all end up here,
 * with a whole definition and, where they have them, the documents.
 *
 * It writes everything or nothing. What is to change is worked out first,
 * from the project as it is read, and then written in one transaction. Its
 * first statement only matches while the project is still as it was read,
 * and leaves a mark of its own on the project; every other statement runs
 * only where that mark is. Limits and the rules about slugs are conditions
 * of that same write. If someone else got there first, it starts over.
 */

export interface ApplyContext {
  db: Db;
  env: Env;
  organizationId: string;
  /** Who applies: a signed-in person in the app, or a deploy API key by its name. */
  actor: { kind: "person" | "key"; id: string; name: string };
  now: number;
  /** Everything before a project's slug in its public URLs. */
  urlPrefix: string;
  /** The origin of the request, for links in emails. */
  origin?: string | undefined;
  /** Hand follow-up work to the runtime instead of waiting for it. */
  defer: (work: Promise<unknown>) => void;
  /**
   * Called once before the service fetches a source for this apply, if it
   * does. Throws to stop it: that is where fetching is charged for.
   */
  beforeFetch: () => Promise<void>;
}

export interface ApplyInput {
  /** The project the request is addressed to. The definition has to be for it. */
  slug: string;
  definition: unknown;
  /** Documents by the name of their source (`main` for a project's only unnamed one). */
  documents?: Record<string, DocumentInput> | undefined;
  /** Request headers for a followed source, by its name. Kept encrypted, never part of the definition. */
  credentials?: Record<string, unknown> | undefined;
  /** What a deploy says about where it ran. */
  origin?: AppliedRecord["origin"] | undefined;
  /** Apply only if the project is still at this revision. */
  ifRevision?: number | undefined;
  /** From the app, on a project that was deployed from a file: edit it in the app from now on. */
  editInApp?: boolean | undefined;
  /** Work everything out, write nothing. */
  dryRun?: boolean | undefined;
  /**
   * Not for a request to set: the definition is the stored one and only
   * credentials are new (see the credentials route). Where the project is
   * edited, and who applied it last, stay as they are.
   */
  credentialsOnly?: boolean | undefined;
}

const ATTEMPTS = 3;

/**
 * "This column is one of these rows' ids", with the ids as one parameter. A
 * project can lose a hundred variants in one apply, and a statement takes a
 * hundred parameters in all.
 */
const among = (column: AnyColumn, rows: Array<{ id: string }>) =>
  sql`${column} in (select value from json_each(${JSON.stringify(rows.map((row) => row.id))}))`;
const NO_CHANGES: SourceChanges = { added: [], removed: [], changed: [] };

/** A document that came with the request, read and found to be one this can work with. */
async function decode(
  label: string,
  input: DocumentInput,
  /** How many bytes the documents of this request may still come to, together. */
  room: number,
): Promise<InspectedSpec> {
  const tooLarge = () =>
    new UpstreamError(
      "too-large",
      `The documents sent are larger than the ${megabytes(MAX_PROJECT_BYTES)} one project may hold.`,
    );
  let bytes: Uint8Array;
  if (typeof input !== "object" || input === null) {
    throw badRequest(
      `documents.${label} must be { "content": "<text>" } or { "gzip": "<base64>" }.`,
    );
  }
  if ("content" in input && typeof input.content === "string") {
    bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > room) throw atSource(label, tooLarge());
  } else if ("gzip" in input && typeof input.gzip === "string") {
    // Stopped as soon as it is too much: a few kilobytes can decompress to gigabytes.
    bytes = await gunzip(Buffer.from(input.gzip, "base64"), room).catch((error) => {
      if (error instanceof UpstreamError) throw atSource(label, tooLarge());
      throw badRequest(`documents.${label}.gzip is not gzip-compressed data in base64.`);
    });
  } else {
    throw badRequest(
      `documents.${label} must be { "content": "<text>" } or { "gzip": "<base64>" }.`,
    );
  }
  try {
    return inspectDocument(bytes, await sha256Hex(bytes));
  } catch (error) {
    throw atSource(label, error);
  }
}

/** Decompress, giving up as soon as it is more than there is room for. */
async function gunzip(packed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([packed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UpstreamError(
        "too-large",
        `A document is larger than the ${megabytes(maxBytes)} limit.`,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** An error about one source's document, as an answer that names the source. */
function atSource(label: string, error: unknown): unknown {
  if (!(error instanceof UpstreamError)) return error;
  return new ApiError(error.code === "bad-url" ? 400 : 422, error.code, error.message, {
    source: label,
    ...(error.detail ? { detail: error.detail } : {}),
  });
}

/** One source of the definition, with the document it will have and where that comes from. */
interface PlannedSource {
  definition: SourceDefinition;
  label: string;
  position: number;
  /** The row it continues, if the project had this source already. */
  stored: SourceInfo | undefined;
  /** A document that arrived with this apply: uploaded, or fetched just now. */
  fresh: InspectedSpec | FetchedSpec | undefined;
  origin: SourceReport["document"];
  headers: StoredHeader[];
  bodyHash: string;
  bodyBytes: number;
  operations: number;
}

function sameLocation(stored: SourceInfo, definition: SourceDefinition): boolean {
  return definition.url !== undefined ? stored.url === definition.url : stored.file !== null;
}

/**
 * Create a project from a definition, or bring the one with its slug to it.
 * Throws an `ApiError` for everything that is the caller's to fix.
 */
export async function applyDefinition(ctx: ApplyContext, input: ApplyInput): Promise<ApplyResult> {
  const { db, env, now } = ctx;

  const read = readDefinition(input.definition);
  if ("problems" in read) {
    const unsupported = read.problems.length === 1 && read.problems[0]?.path === "version";
    throw new ApiError(
      400,
      unsupported ? "unsupported-version" : "invalid-definition",
      read.problems.map(describeProblem).join(" "),
      { problems: read.problems },
    );
  }
  const { definition } = read;
  if (definition.project !== input.slug) {
    throw badRequest(
      `This definition is for the project "${definition.project}", and was sent to "${input.slug}".`,
    );
  }
  // Where a file is deployed to is the deployer's business. It is not stored.
  delete definition.instance;

  const labels = definition.sources.map(sourceLabel);
  const uploaded = new Map<string, InspectedSpec>();
  let room = MAX_PROJECT_BYTES;
  for (const [label, document] of Object.entries(input.documents ?? {})) {
    if (!labels.includes(label)) {
      throw badRequest(
        `documents.${label}: the definition has no source of that name. Its sources are ${labels.join(", ")}.`,
      );
    }
    const decoded = await decode(label, document, room);
    room -= decoded.bodyBytes;
    uploaded.set(label, decoded);
  }
  for (const label of Object.keys(input.credentials ?? {})) {
    const source = definition.sources[labels.indexOf(label)];
    if (!source?.follow) {
      throw badRequest(
        `credentials.${label}: credentials are for a source with a url that is followed.`,
      );
    }
  }
  // Fetched once, however often the write has to be tried again.
  const fetched = new Map<string, { spec: FetchedSpec; headers: StoredHeader[] }>();
  let fetching: Promise<void> | undefined;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const existing = await db.select().from(projects).where(eq(projects.slug, input.slug)).get();
    if (existing ? existing.organizationId !== ctx.organizationId : false) {
      throw new ApiError(409, "slug-taken", `"${input.slug}" is already taken.`);
    }
    if (!existing && (await slugTaken(db, ctx.organizationId, input.slug))) {
      throw new ApiError(409, "slug-taken", `"${input.slug}" is already taken.`);
    }
    if (
      existing?.managedBy === "file" &&
      ctx.actor.kind === "person" &&
      !input.editInApp &&
      !input.credentialsOnly
    ) {
      throw new ApiError(
        409,
        "managed-by-file",
        "This project is defined in a file and deployed. Change the file and deploy, or switch the project to editing in the app.",
        { applied: existing.applied },
      );
    }
    // What the caller started from, said as a revision: 0 for "there is no such
    // project yet". A save that started from something else would undo what
    // happened in between, and a form that makes a project would write over one.
    if (input.ifRevision !== undefined && (existing?.revision ?? 0) !== input.ifRevision) {
      throw new ApiError(
        409,
        "conflict",
        !existing
          ? "This project no longer exists."
          : input.ifRevision === 0
            ? `There is a project "${input.slug}" already.`
            : "This project was changed by someone else in the meantime.",
      );
    }

    const [metas, variantRows, workspace] = await Promise.all([
      existing ? sourcesOf(db, existing.id) : Promise.resolve([]),
      existing
        ? db.select().from(variants).where(eq(variants.projectId, existing.id))
        : Promise.resolve([]),
      db
        .select({ defaultVisibility: organization.defaultVisibility })
        .from(organization)
        .where(eq(organization.id, ctx.organizationId))
        .get(),
    ]);

    // ---- Sources: which row each continues, and which document it will have.
    const free = new Map(metas.map((meta) => [meta.id, meta]));
    const byLabel = definition.sources.map((source, position) => {
      const label = sourceLabel(source);
      const stored = [...free.values()].find((meta) => labelOf(meta) === label);
      if (stored) free.delete(stored.id);
      return { definition: source, label, position, stored };
    });
    // A source that got a name, or lost it, is still the same source.
    for (const entry of byLabel) {
      if (entry.stored) continue;
      const stored = [...free.values()].find(
        (meta) =>
          (entry.definition.url !== undefined && meta.url === entry.definition.url) ||
          (entry.definition.file !== undefined && meta.file === entry.definition.file),
      );
      if (stored) {
        free.delete(stored.id);
        entry.stored = stored;
      }
    }

    const planned: PlannedSource[] = [];
    for (const entry of byLabel) {
      const { definition: source, label, stored } = entry;
      const sent =
        input.credentials && Object.hasOwn(input.credentials, label)
          ? input.credentials[label]
          : undefined;
      const keepsHeaders =
        stored !== undefined &&
        source.follow === true &&
        sameOrigin(stored.url, source.url ?? null);
      let headers =
        sent !== undefined
          ? await resolveHeaders(sent, keepsHeaders ? (stored?.headers ?? []) : [], env.AUTH_SECRET)
          : keepsHeaders
            ? (stored?.headers ?? [])
            : [];

      let fresh: PlannedSource["fresh"] = uploaded.get(label);
      let origin: PlannedSource["origin"] = "kept";
      if (fresh) {
        origin = stored?.bodyHash === fresh.bodyHash ? "kept" : "uploaded";
        if (origin === "kept") fresh = undefined;
      } else if (sent === undefined && stored && sameLocation(stored, source)) {
        origin = "kept";
      } else if (source.follow && source.url) {
        // A followed source that has no copy here, or whose credentials are new: the service reads it.
        let got = fetched.get(label);
        if (!got) {
          fetching ??= ctx.beforeFetch();
          await fetching;
          try {
            const spec = await fetchSpec(source.url, await openHeaders(env.AUTH_SECRET, headers));
            if (spec === "not-modified" || "identical" in spec) {
              throw new UpstreamError("http-error", "The source answered 304 to a first request.");
            }
            got = { spec, headers };
            fetched.set(label, got);
          } catch (error) {
            throw atSource(label, error);
          }
        }
        headers = got.headers;
        fresh = got.spec;
        origin = "fetched";
      } else {
        throw new ApiError(
          422,
          "document-missing",
          `sources[${entry.position}] (${label}) has no document. Send it with the definition, as "openapi-proxy deploy" does${source.url ? ", or let the service read the address with follow: true" : ""}.`,
          { source: label },
        );
      }
      const document = fresh ?? stored;
      if (!document) throw new Error("A source without a document.");
      planned.push({
        ...entry,
        fresh,
        origin,
        headers,
        bodyHash: document.bodyHash,
        bodyBytes: document.bodyBytes,
        operations: document.operations,
      });
    }
    const removedSources = [...free.values()];

    // ---- The project's document: assembled again only if what it is made of changed.
    const order = mergeOrder(definition).map((source) => {
      const part = planned.find((candidate) => candidate.definition === source);
      if (!part) throw new Error("A source that was not planned.");
      return part;
    });
    const hash = await projectHash(
      order.map((part) => ({
        name: part.label,
        pathPrefix: part.definition.pathPrefix ?? null,
        bodyHash: part.bodyHash,
      })),
    );
    let assembled: Assembled;
    let changes = NO_CHANGES;
    let previousOps = existing?.opIndex ?? [];
    if (existing && existing.bodyHash === hash) {
      const { specVersion, bodyHash, bodyBytes, opIndex, notes } = existing;
      assembled = { specVersion, bodyHash, bodyBytes, opIndex, notes };
    } else {
      const bodies = existing ? await storedBodies(db, existing.id) : new Map<string, string>();
      // A source that was there a moment ago and has no document now was
      // removed by someone else while this was reading. Start over from what is there.
      if (metas.some((meta) => !bodies.has(meta.id))) continue;
      const stored = (meta: SourceInfo): Promise<SourceDocument> =>
        parseStored(bodies.get(meta.id) as string).then((doc) => ({
          name: labelOf(meta),
          pathPrefix: meta.pathPrefix,
          bodyHash: meta.bodyHash,
          bodyBytes: meta.bodyBytes,
          doc,
        }));
      assembled = await assembleProject(
        await Promise.all(
          order.map(async (part): Promise<SourceDocument> => {
            const base = { name: part.label, pathPrefix: part.definition.pathPrefix ?? null };
            if (part.fresh) {
              const { bodyHash, bodyBytes, doc } = part.fresh;
              return { ...base, bodyHash, bodyBytes, doc };
            }
            return { ...(await stored(part.stored as SourceInfo)), ...base };
          }),
        ),
      );
      if (existing) {
        previousOps = await previousOperations(existing.opIndex, assembled.opIndex, () =>
          Promise.all(inMergeOrder(metas).map(stored)),
        );
        changes = diffOperations(previousOps, assembled.opIndex);
      }
    }

    // ---- Variants: updated in place by slug, so their ids, keys and stored output stay.
    const index = asIndex(assembled.opIndex);
    const rowBySlug = new Map(variantRows.map((row) => [row.slug, row]));
    // Every variant the project serves: the original, which every project has, and the definition's own.
    const slugs = servedSlugs(definition);
    // What counts against a plan: every variant but the original.
    const counted = slugs.length - 1;
    const plannedVariants = await Promise.all(
      slugs.map(async (slug, position) => {
        const columns = variantColumns(slug, definition.variants[slug] ?? {});
        const effective = effectiveVariant(definition, slug);
        const servedHash = await sha256Hex(canonicalJson(effective));
        const row = rowBySlug.get(slug);
        const action: VariantReport["action"] = !row
          ? "created"
          : canonicalJson(columns) !== canonicalJson(ownColumns(row))
            ? "changed"
            : "unchanged";
        const write =
          action !== "unchanged" || row?.servedHash !== servedHash || row?.position !== position;
        return {
          slug,
          position,
          columns,
          servedHash,
          row,
          action,
          write,
          report: {
            slug,
            action,
            url: `${ctx.urlPrefix}${definition.project}/${slug}`,
            visibility: effectiveVisibility(
              definition,
              slug,
              workspace?.defaultVisibility ?? "public",
            ),
            servedOperations: resolveSelection(index, effective.selection).size,
            totalOperations: index.totalOperations,
            notFound: unmatchedNames(index, effective.selection),
          } satisfies VariantReport,
        };
      }),
    );
    const removedVariants = variantRows.filter((row) => !slugs.includes(row.slug));
    const removedKeys =
      removedVariants.length > 0
        ? await db
            .select({ variantId: apiKeys.variantId, n: count() })
            .from(apiKeys)
            .where(among(apiKeys.variantId, removedVariants))
            .groupBy(apiKeys.variantId)
        : [];

    // ---- What a plan allows. Checked here to say so early; enforced by the write itself.
    const { plan, limits } = await planOf(db, env, ctx.organizationId);
    const elsewhere = sql<number>`(
      select count(*) from ${variants}
      inner join ${projects} on ${projects.id} = ${variants.projectId}
      where ${projects.organizationId} = ${ctx.organizationId}
        and ${projects.slug} <> ${input.slug}
        and ${variants.slug} <> ${ORIGINAL_VARIANT}
    )`;
    const growing = counted > variantRows.filter((row) => row.slug !== ORIGINAL_VARIANT).length;
    if (!existing) {
      const [owned] = await db
        .select({ n: count() })
        .from(projects)
        .where(eq(projects.organizationId, ctx.organizationId));
      if ((owned?.n ?? 0) >= limits.projects) {
        throw planLimit(plan, `The ${PLAN_NAMES[plan]} plan includes ${limits.projects} projects.`);
      }
    }
    if ((growing || !existing) && Number.isFinite(limits.variants)) {
      const [others] = await db
        .select({ n: count() })
        .from(variants)
        .innerJoin(projects, eq(projects.id, variants.projectId))
        .where(
          and(
            eq(projects.organizationId, ctx.organizationId),
            ne(projects.slug, input.slug),
            ne(variants.slug, ORIGINAL_VARIANT),
          ),
        );
      if ((others?.n ?? 0) + counted > limits.variants) {
        throw planLimit(plan, `The ${PLAN_NAMES[plan]} plan includes ${limits.variants} variants.`);
      }
    }

    // ---- Keeping followed sources current.
    const followed = planned.filter((part) => part.definition.follow);
    const deploy = ctx.actor.kind === "key";
    const justFetched = followed.length > 0 && followed.every((part) => part.origin === "fetched");
    const stillFailing = followed.some(
      (part) => part.origin !== "fetched" && part.stored?.lastStatus === "error",
    );
    const watchUntil =
      followed.length === 0 ? null : deploy ? now + WATCH_MS : (existing?.watchUntil ?? null);
    const cheap = followed.map((part) => {
      const validators =
        part.fresh && "etag" in part.fresh
          ? { etag: part.fresh.etag, modified: part.fresh.lastModified }
          : part.fresh
            ? { etag: null, modified: null }
            : { etag: part.stored?.upstreamEtag, modified: part.stored?.upstreamLastModified };
      return Boolean(validators.etag || validators.modified);
    });
    const schedule = {
      watchUntil,
      // A deploy says the API is about to change: the timer looks at its next run.
      nextCheckAt:
        followed.length === 0
          ? null
          : deploy
            ? now
            : (existing?.nextCheckAt ??
              nextCheckAt({ now, cheap, failed: false, wasFailing: false, watchUntil })),
      ...(justFetched ? { checkedAt: now } : {}),
      // The error that is shown is that of a followed source. If none of the
      // sources that are followed now is failing (it was removed, or read
      // just now from another address), there is nothing left to show.
      ...(stillFailing ? {} : { lastStatus: "ok" as const, lastError: null }),
    };

    const keeps = input.credentialsOnly === true && existing !== undefined;
    const managedBy = keeps ? existing.managedBy : deploy ? ("file" as const) : ("app" as const);
    const applied: AppliedRecord | null = keeps
      ? existing.applied
      : {
          at: now,
          by: ctx.actor,
          ...(input.origin && Object.keys(input.origin).length > 0 ? { origin: input.origin } : {}),
        };
    const result = (project: Pick<ProjectRow, "revision" | "managedBy">): ApplyResult => ({
      dryRun: input.dryRun === true,
      created: !existing,
      tookOver: Boolean(existing && existing.managedBy === "app" && deploy),
      project: { slug: input.slug, revision: project.revision, managedBy: project.managedBy },
      sources: [
        ...planned.map(
          (part): SourceReport => ({
            name: part.label,
            action: !part.stored
              ? "added"
              : part.fresh ||
                  canonicalJson(sourceColumns(part.definition, planned.length > 1)) !==
                    canonicalJson(storedColumns(part.stored)) ||
                  part.stored.position !== part.position
                ? "updated"
                : "unchanged",
            document: part.origin,
            follow: part.definition.follow === true,
            bytes: part.bodyBytes,
            operations: part.operations,
          }),
        ),
        ...removedSources.map(
          (meta): SourceReport => ({
            name: labelOf(meta),
            action: "removed",
            document: "kept",
            follow: meta.follow,
            bytes: meta.bodyBytes,
            operations: meta.operations,
          }),
        ),
      ],
      variants: [
        ...plannedVariants.map((variant) => variant.report),
        ...removedVariants.map(
          (row): VariantReport => ({
            slug: row.slug,
            action: "deleted",
            url: `${ctx.urlPrefix}${input.slug}/${row.slug}`,
            visibility: { value: row.visibility ?? "private", from: "variant" },
            servedOperations: 0,
            totalOperations: index.totalOperations,
            notFound: {
              include: { operations: [], tags: [] },
              exclude: { operations: [], tags: [] },
            },
            keysRemoved: removedKeys.find((entry) => entry.variantId === row.id)?.n ?? 0,
          }),
        ),
      ],
      operations: {
        total: index.totalOperations,
        added: changes.added.map((entry) => entry.key),
        removed: changes.removed.map((entry) => entry.key),
        changed: changes.changed.map((entry) => entry.key),
      },
      warnings: warningsOf(definition),
      definition,
    });
    // Documents are compressed before anything is written: a document that is
    // too large to keep is found out here, in a dry run too. (And a query is a
    // thenable: handing one to a promise would run it outside the batch.)
    const packed = new Map<PlannedSource, string>();
    for (const part of planned) {
      if (part.fresh) packed.set(part, await packSpec(part.fresh.body));
    }
    if (input.dryRun) {
      return result({
        revision: existing ? existing.revision + 1 : 1,
        managedBy,
      });
    }

    const several = planned.length > 1;
    /** What a source's entry in the definition says. */
    const entryFields = (part: PlannedSource) => ({
      ...sourceColumns(part.definition, several),
      position: part.position,
      headers: part.headers,
    });
    /** What a document that arrived with this apply says about itself. */
    const documentFields = (part: PlannedSource, fresh: InspectedSpec | FetchedSpec) => ({
      title: fresh.title,
      apiVersion: fresh.apiVersion,
      specVersion: fresh.specVersion,
      upstreamEtag: "etag" in fresh ? fresh.etag : null,
      upstreamLastModified: "lastModified" in fresh ? fresh.lastModified : null,
      bodyHash: fresh.bodyHash,
      bodyBytes: fresh.bodyBytes,
      body: packed.get(part) as string,
      operations: fresh.operations,
      verifiedAt: now,
      lastStatus: "ok" as const,
      lastError: null,
    });
    const variantRow = (variant: (typeof plannedVariants)[number]) => ({
      ...variant.columns,
      position: variant.position,
      servedHash: variant.servedHash,
      ...(variant.action !== "unchanged" ? { updatedAt: now } : {}),
    });
    const projectFields = {
      name: definition.name ?? null,
      visibility: definition.visibility ?? null,
      overrides: definition.overrides ?? null,
      managedBy,
      applied,
      ...assembled,
      ...schedule,
    };

    let written: ProjectRow | undefined;
    try {
      written = existing ? await update(existing) : await create(newId("prj"));
    } catch (error) {
      // Lost a race for the slug, of the project or of a variant, or the
      // project was deleted while this was adding to it: look again.
      if (isUniqueViolation(error) || isMissingParent(error)) continue;
      throw error;
    }
    if (!written) continue;

    // People are told what a new document changed. What an edit to the
    // definition does to the operations (a source added or removed, a path
    // prefix, another main document) is the doing of whoever made it, and no
    // news to them. So the report is for an apply that brings a new document
    // for sources that are merged exactly as they were.
    const mergedAsBefore =
      removedSources.length === 0 &&
      planned.every(
        (part) =>
          part.stored !== undefined &&
          labelOf(part.stored) === part.label &&
          (part.stored.pathPrefix ?? null) === (part.definition.pathPrefix ?? null) &&
          part.stored.main === sourceColumns(part.definition, planned.length > 1).main &&
          part.stored.position === part.position,
      );
    const arrived = planned.some((part) => part.fresh !== undefined);
    if (existing && arrived && mergedAsBefore && hasChanges(changes)) {
      ctx.defer(
        notifyOfChanges(db, env, written, previousOps, changes, ctx.origin).catch((error) => {
          console.error("change notification failed", error);
        }),
      );
    }
    return result(written);

    /** Bring the project to the definition, if it is still as it was read. */
    async function update(project: ProjectRow): Promise<ProjectRow | undefined> {
      const next = project.revision + 1;
      // Its own mark on the project. "The project is at the next revision"
      // would not do: another apply may be the one that put it there.
      const writer = randomToken(16);
      const taken = exists(
        db
          .select({ one: sql`1` })
          .from(projects)
          .where(and(eq(projects.id, project.id), eq(projects.writer, writer))),
      );
      const fits =
        growing && Number.isFinite(limits.variants)
          ? sql`${elsewhere} + ${counted} <= ${limits.variants}`
          : undefined;
      const statements: BatchItem<"sqlite">[] = [];
      if (removedSources.length > 0) {
        statements.push(db.delete(sources).where(and(among(sources.id, removedSources), taken)));
      }
      if (removedVariants.length > 0) {
        statements.push(db.delete(variants).where(and(among(variants.id, removedVariants), taken)));
      }
      for (const part of planned) {
        if (part.stored) {
          statements.push(
            db
              .update(sources)
              .set({
                ...entryFields(part),
                ...(part.fresh ? documentFields(part, part.fresh) : {}),
              })
              .where(and(eq(sources.id, part.stored.id), taken)),
          );
        } else {
          statements.push(...insertSource(project.id, part, taken));
        }
      }
      for (const variant of plannedVariants) {
        if (!variant.write) continue;
        if (variant.row) {
          statements.push(
            db
              .update(variants)
              .set(variantRow(variant))
              .where(and(eq(variants.id, variant.row.id), taken)),
          );
        } else {
          statements.push(...insertVariant(project.id, variant, taken));
        }
      }
      const [rows] = await db.batch([
        db
          .update(projects)
          .set({ ...projectFields, revision: next, writer })
          .where(
            and(
              eq(projects.id, project.id),
              eq(projects.revision, project.revision),
              // A check stored a new document in the meantime: start over from it.
              eq(projects.bodyHash, project.bodyHash),
              fits,
            ),
          )
          .returning(),
        ...statements,
      ]);
      return (rows as ProjectRow[])[0];
    }

    /** Make the project, unless that takes the workspace past what it may have. */
    async function create(id: string): Promise<ProjectRow | undefined> {
      const here = eq(projects.id, id);
      const always = sql`1 = 1`;
      const statements: BatchItem<"sqlite">[] = [
        db.insert(projects).values({
          id,
          organizationId: ctx.organizationId,
          slug: input.slug,
          ...projectFields,
          revision: 1,
          createdAt: now,
        }),
        ...planned.flatMap((part) => insertSource(id, part, always)),
        ...plannedVariants.flatMap((variant) => insertVariant(id, variant, always)),
        // The limits, exactly: the project counts itself, and comes back out if it is one too many.
        db
          .delete(projects)
          .where(
            and(
              here,
              sql`(select count(*) from ${projects} where ${projects.organizationId} = ${ctx.organizationId}) > ${limits.projects}`,
            ),
          ),
        ...(Number.isFinite(limits.variants)
          ? [
              db
                .delete(projects)
                .where(and(here, sql`${elsewhere} + ${counted} > ${limits.variants}`)),
            ]
          : []),
        // And a slug that is held for another workspace is not this one's to take.
        db.delete(projects).where(
          and(
            here,
            exists(
              db
                .select({ one: sql`1` })
                .from(releasedSlugs)
                .where(
                  and(eq(releasedSlugs.slug, input.slug), heldForOthers(ctx.organizationId, now)),
                ),
            ),
          ),
        ),
      ];
      const results = await db.batch([
        ...statements,
        db.select().from(projects).where(here),
      ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      const [made] = results.at(-1) as ProjectRow[];
      // Gone again: the next attempt says which limit it was.
      return made;
    }

    /** An insert cannot be made conditional as simply as an update, so the row goes in and comes straight back out unless the write was taken. */
    function insertSource(projectId: string, part: PlannedSource, taken: ReturnType<typeof sql>) {
      const id = newId("src");
      if (!part.fresh) throw new Error("A new source without a document.");
      return [
        db
          .insert(sources)
          .values({ id, projectId, ...entryFields(part), ...documentFields(part, part.fresh) }),
        db.delete(sources).where(and(eq(sources.id, id), not(taken))),
      ];
    }
    function insertVariant(
      projectId: string,
      variant: (typeof plannedVariants)[number],
      taken: ReturnType<typeof sql>,
    ) {
      const id = newId("var");
      return [
        db.insert(variants).values({
          id,
          projectId,
          ...variantRow(variant),
          createdAt: now,
          updatedAt: now,
        }),
        db.delete(variants).where(and(eq(variants.id, id), not(taken))),
      ];
    }
  }

  throw new ApiError(
    409,
    "conflict",
    "This project kept changing while the definition was being applied. Try again.",
  );
}

/** The columns of a variant row that come from its entry in the definition. */
function ownColumns(row: VariantRow) {
  const { slug, name, icon, visibility, selection, overrides } = row;
  return { slug, name, icon, visibility, selection, overrides };
}

function storedColumns(meta: SourceInfo) {
  const { name, url, file, follow, main, pathPrefix } = meta;
  return { name, url, file, follow, main, pathPrefix };
}
