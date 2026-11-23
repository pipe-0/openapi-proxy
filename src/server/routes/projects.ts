import {
  isValidPathPrefix,
  isValidSlug,
  normalizePathPrefix,
  serialize,
  slugify,
  withBudget,
} from "@openapi-proxy/core";
import {
  and,
  count,
  desc,
  eq,
  gt,
  like,
  lte,
  ne,
  not,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type Context, Hono } from "hono";
import { PLAN_NAMES } from "../../shared/plans";
import {
  assembleProject,
  documentFrom,
  MAX_SOURCES_PER_PROJECT,
  projectAt,
  type SourceDocument,
  type SourceInfo,
  type StoredPart,
  sourceMeta,
  sourcesOf,
  storedParts,
} from "../assemble";
import { checkProject } from "../check";
import { unpack } from "../codec";
import { createDb, type Db } from "../db/client";
import {
  type ProjectRow,
  projectNotifications,
  projects,
  releasedSlugs,
  type StoredHeader,
  sources,
  variants,
} from "../db/schema";
import type { AppContext } from "../env";
import { ApiError, badRequest, isUniqueViolation, notFound, planLimit, readJson } from "../errors";
import { newId, randomToken } from "../id";
import { positionOf } from "../limits";
import { isNotificationScope } from "../notify";
import { planOf } from "../plans";
import { urlPrefix } from "../public-url";
import { contactsSource } from "../rate-limit";
import { checkInterval, nextCheckAt } from "../schedule";
import { headerProblem, MAX_SOURCE_HEADERS, openHeaders, sealHeaders } from "../secrets";
import {
  type FetchedSpec,
  fetchSpec,
  packSpec,
  UpstreamError,
  validateSourceUrl,
} from "../upstream";

export const projectRoutes = new Hono<AppContext>();

/** Where emails about a check started here link back to, and how they are sent without holding the response. */
const followUp = (c: Context<AppContext>) => ({
  origin: new URL(c.req.url).origin,
  defer: (work: Promise<unknown>) => c.executionCtx.waitUntil(work),
});

/** A source as the app sees it. Header values never leave the server; only their names do. */
function sourceToApi(source: SourceInfo) {
  const {
    projectId: _project,
    headers,
    upstreamEtag,
    upstreamLastModified,
    bodyHash: _hash,
    cheap,
    ...rest
  } = source;
  return {
    ...rest,
    /** Whether a check of this source can skip the download. */
    cheap: Boolean(cheap),
    headerNames: headers.map((header) => header.name),
    /** What the source sends that lets a check skip the download, if anything. */
    validator: upstreamEtag
      ? ("etag" as const)
      : upstreamLastModified
        ? ("last-modified" as const)
        : null,
  };
}

/** A project as the app sees it, with its sources in order (the first is the main one). */
export function projectToApi(project: ProjectRow, projectSources: SourceInfo[], prefix: string) {
  const { organizationId: _org, nextCheckAt: _next, opIndex, ...rest } = project;
  const every = checkInterval(projectSources.map((source) => Boolean(source.cheap)));
  return {
    ...rest,
    /** How long the service lets a copy age before it checks again. Not a setting. */
    checkIntervalSeconds: every / 1000,
    /** Every operation of its document, by key: what a selection is made of. */
    operations: opIndex,
    /** Everything before the project's slug in its public URLs. */
    urlPrefix: prefix,
    sources: projectSources.map(sourceToApi),
  };
}

async function respond(
  c: Context<AppContext>,
  db: Db,
  project: ProjectRow,
  status: 200 | 201 = 200,
) {
  return c.json(projectToApi(project, await sourcesOf(db, project.id), urlPrefix(c)), status);
}

async function findProject(db: Db, organizationId: string, id: string): Promise<ProjectRow> {
  const project = await db
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.id, id)))
    .get();
  if (!project) throw notFound("Project");
  return project;
}

/**
 * Turn the header list from a request into stored (encrypted) headers. An
 * entry without a value keeps the value already stored under that name, so
 * the UI can show existing headers and send the list back without ever having
 * held their values.
 */
async function resolveHeaders(
  input: unknown,
  existing: StoredHeader[],
  secret: string | undefined,
): Promise<StoredHeader[]> {
  if (!Array.isArray(input)) throw badRequest("headers must be a list of { name, value }.");
  if (input.length > MAX_SOURCE_HEADERS) {
    throw badRequest(`At most ${MAX_SOURCE_HEADERS} request headers are supported.`);
  }

  const kept: StoredHeader[] = [];
  const fresh: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();

  for (const entry of input) {
    const { name, value } = (entry ?? {}) as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || (value !== undefined && typeof value !== "string")) {
      throw badRequest("headers must be a list of { name, value }.");
    }
    const trimmed = name.trim();
    const problem = headerProblem(trimmed, value);
    if (problem) throw badRequest(problem);
    if (seen.has(trimmed.toLowerCase())) throw badRequest(`${trimmed} is listed twice.`);
    seen.add(trimmed.toLowerCase());

    if (value === undefined) {
      const stored = existing.find((h) => h.name.toLowerCase() === trimmed.toLowerCase());
      if (!stored) throw badRequest(`A value is required for ${trimmed}.`);
      kept.push(stored);
    } else {
      fresh.push({ name: trimmed, value });
    }
  }

  if (fresh.length === 0) return kept;
  if (!secret) throw new ApiError(503, "not-configured", "AUTH_SECRET is not set.");
  return [...kept, ...(await sealHeaders(secret, fresh))];
}

/** A readable default for the project's URL segment: "Pipe0 API" becomes "pipe0". */
function suggestSlug(title: string | null, url: URL): string {
  const fromTitle = slugify((title ?? "").replace(/\bapi\b/gi, " "));
  if (isValidSlug(fromTitle)) return fromTitle;
  const fromHost = slugify(url.hostname.replace(/^(api|www)\./, "").split(".")[0] ?? "");
  if (isValidSlug(fromHost)) return fromHost;
  return `project-${randomToken(4)}`;
}

/** How long a slug that was given up stays with the workspace that had it. */
const SLUG_HOLD_MS = 90 * 24 * 60 * 60 * 1000;
/** How many given-up slugs one workspace holds at a time: the most recent ones. */
const MAX_HELD_SLUGS = 10;

/** Slugs that other workspaces gave up recently (see `releasedSlugs`). */
const heldForOthers = (organizationId: string) =>
  and(
    ne(releasedSlugs.organizationId, organizationId),
    gt(releasedSlugs.releasedAt, Date.now() - SLUG_HOLD_MS),
  );

/**
 * Whether this workspace cannot have a slug. Project slugs are unique across
 * the deployment, since they are the first segment of public URLs, and one
 * that another workspace gave up is held for it for a while.
 */
async function slugTaken(db: Db, organizationId: string, slug: string, except = "") {
  const [used, held] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.slug, slug), ne(projects.id, except)))
      .get(),
    db
      .select({ slug: releasedSlugs.slug })
      .from(releasedSlugs)
      .where(and(eq(releasedSlugs.slug, slug), heldForOthers(organizationId)))
      .get(),
  ]);
  return Boolean(used || held);
}

/** The slug that was asked for, or the first numbered one after it that is free. */
async function availableSlug(db: Db, organizationId: string, wanted: string): Promise<string> {
  const stem = `${wanted.slice(0, 60)}%`;
  const [used, held] = await Promise.all([
    db.select({ slug: projects.slug }).from(projects).where(like(projects.slug, stem)),
    db
      .select({ slug: releasedSlugs.slug })
      .from(releasedSlugs)
      .where(and(like(releasedSlugs.slug, stem), heldForOthers(organizationId))),
  ]);
  const taken = new Set([...used, ...held].map((row) => row.slug));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted.slice(0, 60)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Record that a project no longer uses a slug, in the same transaction that
 * frees it. A workspace holds the last few slugs it gave up, not all of them:
 * the hold is there so that an address in use does not change hands, not so
 * that names can be collected by renaming a project through them.
 */
const releaseSlug = (db: Db, organizationId: string, slug: string) => {
  const now = Date.now();
  const released = { organizationId, releasedAt: now };
  const newest = db
    .select({ slug: releasedSlugs.slug })
    .from(releasedSlugs)
    .where(eq(releasedSlugs.organizationId, organizationId))
    .orderBy(desc(releasedSlugs.releasedAt), desc(releasedSlugs.slug))
    .limit(MAX_HELD_SLUGS);
  return [
    db
      .insert(releasedSlugs)
      .values({ slug, ...released })
      .onConflictDoUpdate({ target: releasedSlugs.slug, set: released }),
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
};

/** `billing` and `/billing/` are fine; anything that is not plain path segments is not. */
function readPathPrefix(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  const prefix =
    typeof input === "string" && input.length <= 300 ? normalizePathPrefix(input) : input;
  if (prefix === undefined) return null;
  if (typeof prefix !== "string" || !isValidPathPrefix(prefix)) {
    throw badRequest(
      "A path prefix looks like /billing: letters, digits, dots, dashes and slashes.",
    );
  }
  return prefix;
}

/** A name for a source that no other source of the project has. */
function uniqueName(wanted: string, taken: string[]): string {
  const base = wanted.trim().slice(0, 100) || "Document";
  let name = base;
  for (let n = 2; taken.some((other) => other.toLowerCase() === name.toLowerCase()); n++) {
    name = `${base} ${n}`;
  }
  return name;
}

/** Fetch a document that is about to become a source, with the headers given for it. */
async function fetchNew(
  c: Context<AppContext>,
  input: { url?: unknown; headers?: unknown },
  several: boolean,
): Promise<{ url: URL; headers: StoredHeader[]; fetched: FetchedSpec }> {
  const url = validateSourceUrl(input.url);
  const headers =
    input.headers === undefined ? [] : await resolveHeaders(input.headers, [], c.env.AUTH_SECRET);
  try {
    const fetched = await fetchSpec(url.href, await openHeaders(c.env.AUTH_SECRET, headers));
    if (fetched === "not-modified" || "identical" in fetched) {
      throw new ApiError(502, "unexpected", "The source answered 304 to an unconditional request.");
    }
    return { url, headers, fetched };
  } catch (error) {
    // With several documents, say which one it is about.
    if (several && error instanceof UpstreamError) {
      throw new UpstreamError(error.code, `${url.host}: ${error.message}`, error.detail);
    }
    throw error;
  }
}

/** The row of a source that was just fetched. */
async function newSource(
  projectId: string,
  position: number,
  name: string,
  pathPrefix: string | null,
  { url, headers, fetched }: Awaited<ReturnType<typeof fetchNew>>,
  now: number,
) {
  return {
    id: newId("src"),
    projectId,
    position,
    name,
    url: url.href,
    headers,
    pathPrefix,
    apiVersion: fetched.apiVersion,
    specVersion: fetched.specVersion,
    upstreamEtag: fetched.etag,
    upstreamLastModified: fetched.lastModified,
    bodyHash: fetched.bodyHash,
    bodyBytes: fetched.bodyBytes,
    body: await packSpec(fetched.body),
    operations: fetched.operations,
    verifiedAt: now,
  };
}

const asPart = (name: string, pathPrefix: string | null, fetched: FetchedSpec): SourceDocument => ({
  name,
  pathPrefix,
  bodyHash: fetched.bodyHash,
  bodyBytes: fetched.bodyBytes,
  doc: fetched.doc,
});

/** What an edit to a project's sources comes to. */
interface SourceEdit {
  /** The project's documents as they should be, in order. */
  parts: SourceDocument[];
  /**
   * The statements that make the stored sources match. `taken` holds, inside
   * the transaction, exactly when the project accepted the edit; every
   * statement has to depend on it.
   */
  statements: (taken: SQL) => BatchItem<"sqlite">[];
}

const EDIT_ATTEMPTS = 3;

/**
 * Change what a project is assembled from: add, remove, reorder or alter a
 * source. `plan` is handed the project's documents as they are stored now
 * and says what they should become.
 *
 * The project's new description and the change to its sources are stored in
 * one transaction, and only if the project is still as `plan` saw it. If a
 * check stored a new document in the meantime, nothing is written, and the
 * edit is planned again from what is there now. Whichever of the two comes
 * first, a project's operations and hash never describe documents it does not
 * have.
 */
async function editSources(
  c: Context<AppContext>,
  db: Db,
  projectId: string,
  plan: (parts: StoredPart[]) => SourceEdit | Promise<SourceEdit>,
): Promise<ProjectRow> {
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
    // The project first, then its documents: a write between the two reads
    // moves the project on from the hash read here, and the guard catches it.
    const project = await findProject(db, c.var.organizationId, projectId);
    const edit = await plan(await storedParts(db, project.id));
    // Assembled before anything is stored: documents that cannot be merged are refused.
    const assembled = await assembleProject(edit.parts);

    const update = db
      .update(projects)
      .set(assembled)
      .where(and(eq(projects.id, project.id), eq(projects.bodyHash, project.bodyHash)))
      .returning();
    const taken = projectAt(db, project.id, assembled.bodyHash);
    const [rows] = await db.batch([update, ...edit.statements(taken)] as [
      typeof update,
      ...BatchItem<"sqlite">[],
    ]);
    if (rows[0]) return rows[0];
  }
  throw new ApiError(
    409,
    "conflict",
    "The project kept changing while this was being saved. Try again.",
  );
}

async function findSource(db: Db, project: ProjectRow, id: string): Promise<SourceInfo> {
  const source = (await sourcesOf(db, project.id)).find((candidate) => candidate.id === id);
  if (!source) throw notFound("Source");
  return source;
}

projectRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const [rows, all] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, c.var.organizationId))
      .orderBy(projects.createdAt),
    db
      .select(sourceMeta)
      .from(sources)
      .innerJoin(projects, eq(projects.id, sources.projectId))
      .where(eq(projects.organizationId, c.var.organizationId))
      .orderBy(sources.position),
  ]);
  const prefix = urlPrefix(c);
  return c.json(
    rows.map((row) =>
      projectToApi(
        row,
        all.filter((source) => source.projectId === row.id),
        prefix,
      ),
    ),
  );
});

/**
 * Create a project from one document, or from several that are merged into
 * one (`sources`, in order: the first is the main one). Every document is
 * fetched and validated first, so a project never exists without something
 * to serve. Posting a single URL that already is a project's main document
 * returns that project, checked.
 */
projectRoutes.post("/", contactsSource, async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = c.var.organizationId;
  const payload = await readJson(c);

  const inputs: Array<{ url?: unknown; headers?: unknown; pathPrefix?: unknown }> = Array.isArray(
    payload.sources,
  )
    ? (payload.sources as Array<Record<string, unknown>>)
    : [{ url: payload.url, headers: payload.headers }];
  if (inputs.length === 0) throw badRequest("A URL is required.");
  if (inputs.length > MAX_SOURCES_PER_PROJECT) {
    throw badRequest(`A project can be merged from up to ${MAX_SOURCES_PER_PROJECT} documents.`);
  }
  const urls = inputs.map((input) => validateSourceUrl(input?.url).href);
  if (new Set(urls).size !== urls.length) throw badRequest("The same URL is listed twice.");

  if (inputs.length === 1) {
    const existing = await db
      .select({ project: projects })
      .from(sources)
      .innerJoin(projects, eq(projects.id, sources.projectId))
      .where(and(eq(projects.organizationId, organizationId), eq(sources.url, urls[0] as string)))
      .orderBy(sources.position)
      .get();
    if (existing) {
      const result = await checkProject(db, c.env, existing.project, Date.now(), followUp(c));
      return respond(c, db, result.project);
    }
  }

  const [owned] = await db
    .select({ n: count() })
    .from(projects)
    .where(eq(projects.organizationId, organizationId));
  const { plan, limits } = await planOf(db, c.env, organizationId);
  if ((owned?.n ?? 0) >= limits.projects) {
    throw planLimit(plan, `The ${PLAN_NAMES[plan]} plan includes ${limits.projects} projects.`);
  }

  const fetched = await Promise.all(inputs.map((input) => fetchNew(c, input, inputs.length > 1)));
  const names: string[] = [];
  const prefixes = inputs.map((input) => readPathPrefix(input.pathPrefix));
  for (const { url, fetched: document } of fetched) {
    names.push(uniqueName(document.title ?? url.hostname, names));
  }
  const assembled = await assembleProject(
    fetched.map(({ fetched: document }, i) =>
      asPart(names[i] as string, prefixes[i] ?? null, document),
    ),
  );

  const now = Date.now();
  const id = newId("prj");
  const [main] = fetched;
  if (!main) throw badRequest("A URL is required.");
  const rows = await Promise.all(
    fetched.map((document, i) =>
      newSource(id, i, names[i] as string, prefixes[i] ?? null, document, now),
    ),
  );
  try {
    const insert = db
      .insert(projects)
      .values({
        id,
        organizationId,
        name: main.fetched.title ?? main.url.hostname,
        slug: await availableSlug(db, organizationId, suggestSlug(main.fetched.title, main.url)),
        ...assembled,
        fetchedAt: now,
        nextCheckAt: nextCheckAt({
          now,
          cheap: fetched.map(({ fetched: document }) =>
            Boolean(document.etag || document.lastModified),
          ),
          failed: false,
          wasFailing: false,
        }),
        createdAt: now,
      })
      .returning();
    const [created] = await db.batch([insert, db.insert(sources).values(rows)]);
    // The count above turned away the ordinary case before any document was
    // fetched. This is the limit itself (see limits.ts).
    const ofWorkspace = eq(projects.organizationId, organizationId);
    if ((await positionOf(db, projects, id, ofWorkspace)) > limits.projects) {
      await db.delete(projects).where(eq(projects.id, id));
      throw planLimit(plan, `The ${PLAN_NAMES[plan]} plan includes ${limits.projects} projects.`);
    }
    return respond(c, db, created[0] as ProjectRow, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "conflict", "A project for this URL was just created. Reload.");
    }
    throw error;
  }
});

projectRoutes.get("/slug-check", async (c) => {
  const slug = c.req.query("slug") ?? "";
  if (!isValidSlug(slug)) return c.json({ slug, valid: false, available: false });
  const except = c.req.query("except") ?? "";
  const taken = await slugTaken(createDb(c.env.DB), c.var.organizationId, slug, except);
  return c.json({ slug, valid: true, available: !taken });
});

projectRoutes.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  return respond(c, db, await findProject(db, c.var.organizationId, c.req.param("id")));
});

/**
 * The project's document: the source as fetched, or several sources merged.
 * The editor runs the same selection and conversion on it in the browser
 * that the Worker runs when serving.
 */
projectRoutes.get("/:id/spec", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const rows = await db
    .select({ name: sources.name, pathPrefix: sources.pathPrefix, body: sources.body })
    .from(sources)
    .where(eq(sources.projectId, project.id))
    .orderBy(sources.position);
  if (rows.length === 0) throw notFound("Source document");
  const texts = await Promise.all(rows.map((row) => unpack(row.body)));
  const body = withBudget(() => {
    const { doc, minified, single } = documentFrom(rows, texts);
    return single ?? serialize(doc, "json", { minified });
  });
  return new Response(body, {
    headers: {
      "content-type": body.trimStart().startsWith("{")
        ? "application/json; charset=utf-8"
        : "application/yaml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});

/**
 * Which changes to this project's documents the person asking is emailed
 * about: "off", "served" (what their variants serve) or "all". Theirs alone.
 */
projectRoutes.get("/:id/notifications", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const own = await db
    .select({ scope: projectNotifications.scope })
    .from(projectNotifications)
    .where(
      and(
        eq(projectNotifications.projectId, project.id),
        eq(projectNotifications.userId, c.var.user.id),
      ),
    )
    .get();
  return c.json({ scope: own?.scope ?? "served" });
});

projectRoutes.put("/:id/notifications", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const { scope } = await readJson(c);
  if (!isNotificationScope(scope)) {
    throw badRequest('scope must be "off", "served" or "all".');
  }
  await db
    .insert(projectNotifications)
    .values({ projectId: project.id, userId: c.var.user.id, scope })
    .onConflictDoUpdate({
      target: [projectNotifications.projectId, projectNotifications.userId],
      set: { scope },
    });
  return c.json({ scope });
});

projectRoutes.post("/:id/check", contactsSource, async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const result = await checkProject(db, c.env, project, Date.now(), followUp(c));
  return c.json({
    changed: result.changed,
    addedOps: result.addedOps,
    removedOps: result.removedOps,
    changedOps: result.changedOps,
    project: projectToApi(result.project, await sourcesOf(db, project.id), urlPrefix(c)),
  });
});

projectRoutes.patch("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const payload = await readJson(c);
  const updates: Partial<ProjectRow> = {};

  if (payload.name !== undefined) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name === "" || name.length > 100) throw badRequest("name must be 1 to 100 characters.");
    updates.name = name;
  }

  if (payload.slug !== undefined && payload.slug !== project.slug) {
    const slug = payload.slug;
    if (typeof slug !== "string" || !isValidSlug(slug)) {
      throw new ApiError(400, "invalid-slug", "Use 2 to 64 characters: a-z, 0-9 and hyphens.");
    }
    if (await slugTaken(db, c.var.organizationId, slug)) {
      throw new ApiError(409, "slug-taken", `"${slug}" is already taken.`);
    }
    updates.slug = slug;
  }

  if (Object.keys(updates).length === 0) throw badRequest("Nothing to update.");
  try {
    const update = db.update(projects).set(updates).where(eq(projects.id, project.id)).returning();
    // The slug it had stays with this workspace for a while (see `releasedSlugs`).
    const [[updated]] = await db.batch(
      updates.slug === undefined
        ? [update]
        : [update, ...releaseSlug(db, c.var.organizationId, project.slug)],
    );
    if (!updated) throw notFound("Project");
    return respond(c, db, updated);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ApiError(409, "slug-taken", "That slug is taken.");
    throw error;
  }
});

// ---- Sources: the documents a project is assembled from ----

/** Add a document. Its operations join the project's; the first document stays the main one. */
projectRoutes.post("/:id/sources", contactsSource, async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const payload = await readJson(c);
  const pathPrefix = readPathPrefix(payload.pathPrefix);
  const added = await fetchNew(c, payload, false);
  const now = Date.now();

  try {
    const updated = await editSources(c, db, project.id, async (parts) => {
      if (parts.length >= MAX_SOURCES_PER_PROJECT) {
        throw new ApiError(
          409,
          "limit-reached",
          `A project can be merged from up to ${MAX_SOURCES_PER_PROJECT} documents.`,
        );
      }
      if (parts.some((part) => part.url === added.url.href)) throw alreadyPart();
      const name = uniqueName(
        typeof payload.name === "string" && payload.name.trim() !== ""
          ? payload.name
          : (added.fetched.title ?? added.url.hostname),
        parts.map((part) => part.name),
      );
      const position = Math.max(...parts.map((part) => part.position)) + 1;
      const row = await newSource(project.id, position, name, pathPrefix, added, now);
      return {
        parts: [...parts, asPart(name, pathPrefix, added.fetched)],
        // An insert cannot be made conditional as simply as an update, so the
        // row goes in and comes straight back out unless the edit was taken.
        statements: (taken) => [
          db.insert(sources).values(row),
          db.delete(sources).where(and(eq(sources.id, row.id), not(taken))),
        ],
      };
    });
    return respond(c, db, updated, 201);
  } catch (error) {
    // Two requests adding the same document at once: the other one did.
    if (isUniqueViolation(error)) throw alreadyPart();
    throw error;
  }
});

const alreadyPart = () =>
  new ApiError(409, "conflict", "This document is already part of the project.");

/** Change how a document is fetched or merged in: its name, path prefix, credentials. */
projectRoutes.patch("/:id/sources/:sourceId", contactsSource, async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const source = await findSource(db, project, c.req.param("sourceId"));
  const payload = await readJson(c);
  const now = Date.now();
  const fields: Partial<typeof sources.$inferInsert> = {};
  /** What changes about this source as a part of the merge. */
  const change: Partial<SourceDocument> = {};

  if (payload.name !== undefined) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name === "" || name.length > 100) throw badRequest("name must be 1 to 100 characters.");
    fields.name = name;
    change.name = name;
  }

  if (payload.pathPrefix !== undefined) {
    fields.pathPrefix = readPathPrefix(payload.pathPrefix);
    change.pathPrefix = fields.pathPrefix;
  }

  if (payload.headers !== undefined) {
    const headers = await resolveHeaders(payload.headers, source.headers, c.env.AUTH_SECRET);
    // Prove the new headers work before they replace the old ones, and keep what they fetched.
    const fetched = await fetchSpec(source.url, await openHeaders(c.env.AUTH_SECRET, headers));
    if (fetched === "not-modified" || "identical" in fetched) {
      throw new ApiError(502, "unexpected", "The source answered 304 to an unconditional request.");
    }
    Object.assign(fields, {
      headers,
      apiVersion: fetched.apiVersion,
      specVersion: fetched.specVersion,
      upstreamEtag: fetched.etag,
      upstreamLastModified: fetched.lastModified,
      bodyHash: fetched.bodyHash,
      bodyBytes: fetched.bodyBytes,
      body: await packSpec(fetched.body),
      operations: fetched.operations,
      verifiedAt: now,
      lastStatus: "ok",
      lastError: null,
    });
    Object.assign(change, {
      bodyHash: fetched.bodyHash,
      bodyBytes: fetched.bodyBytes,
      doc: fetched.doc,
    });
  }

  if (Object.keys(fields).length === 0) throw badRequest("Nothing to update.");

  const updated = await editSources(c, db, project.id, (parts) => {
    if (!parts.some((part) => part.id === source.id)) throw notFound("Source");
    const clash = (part: StoredPart) =>
      part.id !== source.id && part.name.toLowerCase() === change.name?.toLowerCase();
    if (parts.some(clash)) {
      throw new ApiError(409, "conflict", "Another document of this project has that name.");
    }
    return {
      parts: parts.map((part) => (part.id === source.id ? { ...part, ...change } : part)),
      statements: (taken) => [
        db
          .update(sources)
          .set(fields)
          .where(and(eq(sources.id, source.id), taken)),
      ],
    };
  });
  return respond(c, db, updated);
});

/** Make a document the main one: its info and servers describe the project. */
projectRoutes.post("/:id/sources/:sourceId/main", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const sourceId = c.req.param("sourceId");
  const updated = await editSources(c, db, project.id, (parts) => {
    const main = parts.find((part) => part.id === sourceId);
    if (!main) throw notFound("Source");
    const position = Math.min(...parts.map((part) => part.position)) - 1;
    return {
      parts: [main, ...parts.filter((part) => part !== main)],
      statements: (taken) => [
        db
          .update(sources)
          .set({ position })
          .where(and(eq(sources.id, sourceId), taken)),
      ],
    };
  });
  return respond(c, db, updated);
});

/** Take a document out of the project. Its operations go with it. A project keeps at least one. */
projectRoutes.delete("/:id/sources/:sourceId", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));
  const sourceId = c.req.param("sourceId");
  const updated = await editSources(c, db, project.id, (parts) => {
    if (!parts.some((part) => part.id === sourceId)) throw notFound("Source");
    const remaining = parts.filter((part) => part.id !== sourceId);
    if (remaining.length === 0) {
      throw new ApiError(
        409,
        "last-source",
        "A project needs at least one document. Delete the project instead.",
      );
    }
    return {
      parts: remaining,
      statements: (taken) => [db.delete(sources).where(and(eq(sources.id, sourceId), taken))],
    };
  });
  return respond(c, db, updated);
});

projectRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("id"));

  const dependents = await db
    .select({ id: variants.id, name: variants.name, slug: variants.slug })
    .from(variants)
    .where(eq(variants.projectId, project.id));

  if (dependents.length > 0 && c.req.query("cascade") !== "true") {
    throw new ApiError(
      409,
      "has-variants",
      `This project has ${dependents.length} variant(s). Pass ?cascade=true to delete them too.`,
      { variants: dependents },
    );
  }

  // Foreign keys cascade to the sources, the variants and their outputs. The
  // slug stays with this workspace for a while (see `releasedSlugs`).
  await db.batch([
    db.delete(projects).where(eq(projects.id, project.id)),
    ...releaseSlug(db, c.var.organizationId, project.slug),
  ]);
  return c.json({ ok: true, deletedVariants: dependents.length });
});
