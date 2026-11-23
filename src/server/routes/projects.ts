import {
  documentText,
  effectiveVariant,
  effectiveVisibility,
  isValidSlug,
  type ProjectView,
  resolveSelection,
  unmatchedNames,
  type VariantState,
  type Visibility,
} from "@openapi-proxy/core";
import { and, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { type ApplyContext, applyDefinition } from "../apply";
import { labelOf, type SourceInfo, sourceMeta } from "../assemble";
import { checkProject } from "../check";
import { unpack } from "../codec";
import { createDb, type Db } from "../db/client";
import {
  organization,
  type ProjectRow,
  projectNotifications,
  projects,
  sources,
  type VariantRow,
  variants,
} from "../db/schema";
import { definitionFromRows } from "../definition-rows";
import type { AppContext } from "../env";
import { ApiError, badRequest, notFound, readJson } from "../errors";
import { isNotificationScope } from "../notify";
import { asIndex } from "../operations";
import { urlPrefix } from "../public-url";
import { chargeForFetching, contactsSource } from "../rate-limit";
import { checkInterval } from "../schedule";
import { releaseSlug, slugTaken } from "../slugs";

/**
 * Projects, by slug. A project is read as its definition, in the format of an
 * `openapi-proxy.yaml`, next to what the service knows about it. It is
 * changed in one way: by applying a whole definition (apply.ts). The app's
 * editor does that, and so does `openapi-proxy deploy`.
 */
export const projectRoutes = new Hono<AppContext>();

/** What a check or an apply needs in order to tell people about a change after the response is sent. */
const followUp = (c: Context<AppContext>) => ({
  origin: new URL(c.req.url).origin,
  defer: (work: Promise<unknown>) => c.executionCtx.waitUntil(work),
});

/** Everything about a request that an apply works with. */
const applyContext = (c: Context<AppContext>, db: Db): ApplyContext => ({
  db,
  env: c.env,
  organizationId: c.var.organizationId,
  actor: c.var.actor,
  now: Date.now(),
  urlPrefix: urlPrefix(c),
  ...followUp(c),
  beforeFetch: chargeForFetching(c),
});

function viewOf(
  project: ProjectRow,
  projectSources: SourceInfo[],
  projectVariants: VariantRow[],
  workspaceDefault: Visibility,
  prefix: string,
): ProjectView {
  const definition = definitionFromRows(project, projectSources, projectVariants);
  const ordered = [...projectSources].sort((a, b) => a.position - b.position);
  const followed = ordered.filter((source) => source.follow);
  const index = asIndex(project.opIndex);
  const bySlug = new Map(projectVariants.map((row) => [row.slug, row]));

  return {
    definition,
    state: {
      revision: project.revision,
      managedBy: project.managedBy,
      applied: project.applied,
      urlPrefix: prefix,
      specVersion: project.specVersion,
      documentHash: project.bodyHash,
      bodyBytes: project.bodyBytes,
      operations: project.opIndex,
      notes: project.notes,
      check:
        followed.length > 0
          ? {
              intervalSeconds: checkInterval(followed.map((source) => source.cheap === 1)) / 1000,
              checkedAt: project.checkedAt,
              nextCheckAt: project.nextCheckAt,
              watchUntil: project.watchUntil,
              lastStatus: project.lastStatus,
              lastError: project.lastError,
            }
          : null,
      sources: ordered.map((source) => ({
        name: labelOf(source),
        title: source.title,
        headerNames: source.headers.map((header) => header.name),
        validator: source.upstreamEtag
          ? "etag"
          : source.upstreamLastModified
            ? "last-modified"
            : null,
        apiVersion: source.apiVersion,
        specVersion: source.specVersion,
        bodyBytes: source.bodyBytes,
        operations: source.operations,
        readAt: source.verifiedAt,
        lastStatus: source.lastStatus,
        lastError: source.lastError,
      })),
      variants: Object.fromEntries(
        Object.keys(definition.variants).map((slug): [string, VariantState] => {
          const row = bySlug.get(slug) as VariantRow;
          const { selection } = effectiveVariant(definition, slug);
          return [
            slug,
            {
              id: row.id,
              url: `${prefix}${project.slug}/${slug}`,
              visibility: effectiveVisibility(definition, slug, workspaceDefault),
              servedOperations: resolveSelection(index, selection).size,
              totalOperations: index.totalOperations,
              notFound: unmatchedNames(index, selection),
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            },
          ];
        }),
      ),
      defaultVisibility: workspaceDefault,
      createdAt: project.createdAt,
      can: {
        edit: project.managedBy === "app",
        credentials: true,
        keys: true,
        check: followed.length > 0,
      },
    },
  };
}

async function workspaceDefault(db: Db, organizationId: string): Promise<Visibility> {
  const row = await db
    .select({ defaultVisibility: organization.defaultVisibility })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .get();
  return row?.defaultVisibility ?? "public";
}

async function findProject(db: Db, organizationId: string, slug: string): Promise<ProjectRow> {
  const project = await db
    .select()
    .from(projects)
    .where(and(eq(projects.slug, slug), eq(projects.organizationId, organizationId)))
    .get();
  if (!project) throw notFound("Project");
  return project;
}

async function respond(c: Context<AppContext>, db: Db, project: ProjectRow): Promise<Response> {
  const [projectSources, projectVariants, fallback] = await Promise.all([
    db.select(sourceMeta).from(sources).where(eq(sources.projectId, project.id)),
    db.select().from(variants).where(eq(variants.projectId, project.id)),
    workspaceDefault(db, project.organizationId),
  ]);
  return c.json(viewOf(project, projectSources, projectVariants, fallback, urlPrefix(c)));
}

/** Every project of the workspace, oldest first, each as `GET /:slug` gives it. */
projectRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, c.var.organizationId))
    .orderBy(projects.createdAt, projects.id);
  if (rows.length === 0) return c.json([]);

  // By workspace, not by a list of ids: a statement takes a hundred parameters, and so many projects fit a plan.
  const ofWorkspace = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, c.var.organizationId));
  const [allSources, allVariants, fallback] = await Promise.all([
    db.select(sourceMeta).from(sources).where(inArray(sources.projectId, ofWorkspace)),
    db.select().from(variants).where(inArray(variants.projectId, ofWorkspace)),
    workspaceDefault(db, c.var.organizationId),
  ]);
  const prefix = urlPrefix(c);
  return c.json(
    rows.map((project) =>
      viewOf(
        project,
        allSources.filter((source) => source.projectId === project.id),
        allVariants.filter((variant) => variant.projectId === project.id),
        fallback,
        prefix,
      ),
    ),
  );
});

projectRoutes.get("/:slug", async (c) => {
  const db = createDb(c.env.DB);
  return respond(c, db, await findProject(db, c.var.organizationId, c.req.param("slug")));
});

/**
 * Apply a definition: create the project, or bring the one with this slug to
 * it. The one route a deploy API key reaches. `?dryRun=true` works everything
 * out, answers the same, and writes nothing. It costs what any request does,
 * unless the service has to fetch a source for it.
 */
projectRoutes.put("/:slug", async (c) => {
  const payload = await readJson(c);
  const { ifRevision, editInApp } = payload;
  if (ifRevision !== undefined && !Number.isInteger(ifRevision)) {
    throw badRequest("ifRevision must be a whole number.");
  }
  const record = (value: unknown, what: string): Record<string, never> | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw badRequest(`${what} must be an object.`);
    }
    return value as Record<string, never>;
  };
  const origin = record(payload.origin, "origin") as Record<string, unknown> | undefined;
  const said = (key: string) => {
    const value = origin?.[key];
    return typeof value === "string" && value !== "" ? { [key]: value.slice(0, 500) } : {};
  };

  const result = await applyDefinition(applyContext(c, createDb(c.env.DB)), {
    slug: c.req.param("slug"),
    definition: payload.definition,
    documents: record(payload.documents, "documents"),
    credentials: record(payload.credentials, "credentials"),
    origin: origin
      ? { ...said("commit"), ...said("ref"), ...said("repository"), ...said("runUrl") }
      : undefined,
    ifRevision: ifRevision as number | undefined,
    editInApp: editInApp === true,
    dryRun: c.req.query("dryRun") === "true",
  });
  return c.json(result, result.created && !result.dryRun ? 201 : 200);
});

/**
 * The project's document: its sources assembled into one. The editor runs the
 * same selection and conversion on it in the browser that the service runs
 * when serving.
 */
projectRoutes.get("/:slug/document", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("slug"));
  const rows = await db
    .select({
      name: sources.name,
      pathPrefix: sources.pathPrefix,
      main: sources.main,
      position: sources.position,
      body: sources.body,
    })
    .from(sources)
    .where(eq(sources.projectId, project.id));
  if (rows.length === 0) throw notFound("Document");
  rows.sort((a, b) => Number(b.main) - Number(a.main) || a.position - b.position);
  const texts = await Promise.all(rows.map((row) => unpack(row.body)));
  const body = documentText(
    rows.map((row, i) => ({
      name: labelOf(row),
      pathPrefix: row.pathPrefix,
      text: texts[i] ?? "",
    })),
  );
  return new Response(body, {
    headers: {
      "content-type": body.trimStart().startsWith("{")
        ? "application/json; charset=utf-8"
        : "application/yaml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});

/** Look at the sources the service follows, now. What it finds is in the project afterwards. */
projectRoutes.post("/:slug/check", contactsSource, async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("slug"));
  const followed = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.projectId, project.id), eq(sources.follow, true)))
    .get();
  if (!followed) {
    throw new ApiError(
      409,
      "not-followed",
      "This project's documents are uploaded when it is deployed. There is nothing for the service to check.",
    );
  }
  const result = await checkProject(db, c.env, project, Date.now(), followUp(c));
  return c.json({
    changed: result.changed,
    addedOps: result.addedOps,
    removedOps: result.removedOps,
    changedOps: result.changedOps,
    lastStatus: result.project.lastStatus,
    lastError: result.project.lastError,
  });
});

/**
 * The request headers the service sends when it fetches a followed source:
 * `{ source, headers: [{ name, value }] }`. An entry without a value keeps
 * the one that is stored. They are not part of a definition, so this is
 * where they are set, for a project that is deployed from a file too. The
 * source is fetched with them before they are kept.
 */
projectRoutes.put("/:slug/credentials", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const project = await findProject(db, c.var.organizationId, slug);
  const { source, headers } = await readJson(c);
  if (typeof source !== "string") throw badRequest("source must be the name of a source.");

  const [projectSources, projectVariants] = await Promise.all([
    db.select(sourceMeta).from(sources).where(eq(sources.projectId, project.id)),
    db.select().from(variants).where(eq(variants.projectId, project.id)),
  ]);
  if (!projectSources.some((row) => labelOf(row) === source)) throw notFound("Source");

  const result = await applyDefinition(applyContext(c, db), {
    slug,
    definition: definitionFromRows(project, projectSources, projectVariants),
    credentials: { [source]: headers },
    ifRevision: project.revision,
    credentialsOnly: true,
  });
  return c.json(result);
});

/**
 * Which changes to this project's documents the person asking is emailed
 * about: "off", "served" (what its variants serve) or "all". Theirs alone.
 */
projectRoutes.get("/:slug/notifications", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("slug"));
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

projectRoutes.put("/:slug/notifications", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("slug"));
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

/**
 * Delete a project with its variants and the user API keys that were for one
 * of them alone. Its slug stays with this workspace for a while (slugs.ts).
 */
projectRoutes.delete("/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const project = await findProject(db, c.var.organizationId, c.req.param("slug"));
  await db.batch([
    db.delete(projects).where(eq(projects.id, project.id)),
    ...releaseSlug(db, c.var.organizationId, project.slug),
  ]);
  return c.json({ ok: true });
});

/** Whether a slug is free for a new project of this workspace, for the app's field. */
export const slugRoutes = new Hono<AppContext>();

slugRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidSlug(slug)) return c.json({ slug, valid: false, available: false });
  const db = createDb(c.env.DB);
  const [own, taken] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.slug, slug), eq(projects.organizationId, c.var.organizationId)))
      .get(),
    slugTaken(db, c.var.organizationId, slug),
  ]);
  return c.json({ slug, valid: true, available: !own && !taken });
});
