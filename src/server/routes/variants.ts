import {
  type DocumentOverrides,
  isValidSlug,
  readOverrides,
  resolveSelection,
  type Selection,
  slugify,
  unmatchedNames,
} from "@openapi-proxy/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { isVisibility, type Visibility } from "../../shared/access";
import { GUARDS, PLAN_NAMES } from "../../shared/plans";
import { isVariantIcon, VARIANT_ICONS, type VariantIconName } from "../../shared/variant-icons";
import { createDb, type Db } from "../db/client";
import { organization, type ProjectRow, projects, type VariantRow, variants } from "../db/schema";
import type { AppContext } from "../env";
import { ApiError, badRequest, isUniqueViolation, notFound, planLimit, readJson } from "../errors";
import { newId, randomToken } from "../id";
import { positionOf } from "../limits";
import { asIndex } from "../operations";
import { planOf } from "../plans";
import { urlPrefix } from "../public-url";

export const variantRoutes = new Hono<AppContext>();

const SLUG_RULE = "Use 2 to 64 characters: a-z, 0-9 and hyphens.";
const MAX_VARIANTS_PER_PROJECT = GUARDS.variantsPerProject;

function parseSelection(input: unknown): Selection | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const candidate = input as Record<string, unknown>;
  if (candidate.mode !== "include" && candidate.mode !== "exclude") return undefined;

  const list = (value: unknown, max: number): string[] | undefined => {
    if (!Array.isArray(value) || value.length > max) return undefined;
    if (!value.every((item) => typeof item === "string" && item.length <= 2000)) return undefined;
    return [...new Set(value as string[])].sort();
  };
  const operations = list(candidate.operations, 10_000);
  const tags = list(candidate.tags, 2_000);
  if (!operations || !tags) return undefined;
  return { mode: candidate.mode, operations, tags };
}

/** Who may read a variant at its URL. Not given, it is what the workspace starts new variants with. */
function parseVisibility(input: unknown): Visibility | undefined {
  if (input === undefined) return undefined;
  if (!isVisibility(input)) throw badRequest('visibility must be "public" or "private".');
  return input;
}

/** The icon a variant has in the navigation. Null means the plain one. */
function parseIcon(input: unknown): VariantIconName | null {
  if (input === null || input === undefined || input === "") return null;
  if (!isVariantIcon(input)) throw badRequest(`icon must be one of: ${VARIANT_ICONS.join(", ")}.`);
  return input;
}

/** What a variant states at the top of its document instead of the source's. Null means nothing. */
function parseOverrides(input: unknown): DocumentOverrides | null {
  const read = readOverrides(input);
  if (read && "problem" in read) throw badRequest(read.problem);
  return read;
}

function variantToApi(
  variant: VariantRow,
  project: Pick<ProjectRow, "slug" | "opIndex">,
  prefix: string,
) {
  const index = asIndex(project.opIndex);
  return {
    ...variant,
    /** Public path of the served document; append .json or .yaml to pin a format. */
    path: `/v/${project.slug}/${variant.slug}`,
    /** The public URL, without a format extension. */
    url: `${prefix}${project.slug}/${variant.slug}`,
    keptOperations: resolveSelection(index, variant.selection).size,
    totalOperations: index.totalOperations,
    /** Names in the selection that the document has nothing for. */
    notFound: unmatchedNames(index, variant.selection),
  };
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

async function findVariant(db: Db, organizationId: string, id: string) {
  const row = await db
    .select()
    .from(variants)
    .innerJoin(projects, eq(variants.projectId, projects.id))
    .where(and(eq(projects.organizationId, organizationId), eq(variants.id, id)))
    .get();
  if (!row) throw notFound("Variant");
  return { variant: row.variants, project: row.projects };
}

async function slugTaken(db: Db, projectId: string, slug: string): Promise<boolean> {
  const taken = await db
    .select({ id: variants.id })
    .from(variants)
    .where(and(eq(variants.projectId, projectId), eq(variants.slug, slug)))
    .get();
  return Boolean(taken);
}

const takenError = (slug: string) =>
  new ApiError(409, "slug-taken", `"${slug}" is already used by another variant of this project.`);

variantRoutes.get("/", async (c) => {
  const rows = await createDb(c.env.DB)
    .select()
    .from(variants)
    .innerJoin(projects, eq(variants.projectId, projects.id))
    .where(eq(projects.organizationId, c.var.organizationId))
    .orderBy(variants.createdAt);
  return c.json(rows.map((row) => variantToApi(row.variants, row.projects, urlPrefix(c))));
});

/** Is this slug free within the project? Powers the live check in the builder. */
variantRoutes.get("/slug-check", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.query("slug") ?? "";
  const project = await findProject(db, c.var.organizationId, c.req.query("projectId") ?? "");
  if (!isValidSlug(slug)) return c.json({ slug, valid: false, available: false });
  return c.json({ slug, valid: true, available: !(await slugTaken(db, project.id, slug)) });
});

variantRoutes.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const payload = await readJson(c);

  const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const selection = parseSelection(payload.selection);
  if (!projectId || name === "" || name.length > 100 || !selection) {
    throw badRequest(
      "projectId, a name of up to 100 characters and a valid selection are required.",
    );
  }
  const project = await findProject(db, c.var.organizationId, projectId);

  let slug: string;
  if (typeof payload.slug === "string" && payload.slug !== "") {
    slug = payload.slug;
    if (!isValidSlug(slug)) throw new ApiError(400, "invalid-slug", SLUG_RULE);
  } else {
    // A name like "###" derives nothing usable; fall back to a random slug.
    const derived = slugify(name);
    slug = isValidSlug(derived) ? derived : `variant-${randomToken(6)}`;
  }
  if (await slugTaken(db, project.id, slug)) throw takenError(slug);

  // A workspace that works on internal APIs starts its variants private, so
  // that none is ever public for the moment between creating and noticing.
  const visibility =
    parseVisibility(payload.visibility) ??
    (
      await db
        .select({ defaultVisibility: organization.defaultVisibility })
        .from(organization)
        .where(eq(organization.id, c.var.organizationId))
        .get()
    )?.defaultVisibility ??
    "public";

  const now = Date.now();
  const id = newId("var");
  let inserted: VariantRow | undefined;
  try {
    [inserted] = await db
      .insert(variants)
      .values({
        id,
        projectId: project.id,
        name,
        slug,
        selection,
        overrides: parseOverrides(payload.overrides),
        icon: parseIcon(payload.icon),
        visibility,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) throw takenError(slug);
    throw error;
  }

  // Limits are checked by position, after the insert (see limits.ts), so that
  // requests sent together cannot all slip in under them.
  const { plan, limits } = await planOf(db, c.env, c.var.organizationId);
  const ofWorkspace = inArray(
    variants.projectId,
    db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, c.var.organizationId)),
  );
  const [inWorkspace, inProject] = await Promise.all([
    positionOf(db, variants, id, ofWorkspace),
    positionOf(db, variants, id, eq(variants.projectId, project.id)),
  ]);
  const refusal =
    inWorkspace > limits.variants
      ? planLimit(plan, `The ${PLAN_NAMES[plan]} plan includes ${limits.variants} variants.`)
      : inProject > MAX_VARIANTS_PER_PROJECT
        ? new ApiError(
            409,
            "limit-reached",
            `A project can have up to ${MAX_VARIANTS_PER_PROJECT} variants.`,
          )
        : undefined;
  if (refusal) {
    await db.delete(variants).where(eq(variants.id, id));
    throw refusal;
  }
  return c.json(variantToApi(inserted as VariantRow, project, urlPrefix(c)), 201);
});

variantRoutes.get("/:id", async (c) => {
  const { variant, project } = await findVariant(
    createDb(c.env.DB),
    c.var.organizationId,
    c.req.param("id"),
  );
  return c.json(variantToApi(variant, project, urlPrefix(c)));
});

variantRoutes.patch("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const { variant, project } = await findVariant(db, c.var.organizationId, c.req.param("id"));
  const payload = await readJson(c);
  const updates: Partial<VariantRow> = {};
  /** Whether what is served changes, so that its ETag has to. */
  let served = false;

  if (payload.name !== undefined) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name === "" || name.length > 100) throw badRequest("name must be 1 to 100 characters.");
    updates.name = name;
  }

  if (payload.slug !== undefined && payload.slug !== variant.slug) {
    const slug = payload.slug;
    if (typeof slug !== "string" || !isValidSlug(slug)) {
      throw new ApiError(400, "invalid-slug", SLUG_RULE);
    }
    if (await slugTaken(db, project.id, slug)) throw takenError(slug);
    updates.slug = slug;
  }

  if (payload.selection !== undefined) {
    const selection = parseSelection(payload.selection);
    if (!selection) throw badRequest("selection is malformed.");
    updates.selection = selection;
    served = true;
  }

  if (payload.overrides !== undefined) {
    const overrides = parseOverrides(payload.overrides);
    if (JSON.stringify(overrides) !== JSON.stringify(variant.overrides)) {
      updates.overrides = overrides;
      served = true;
    }
  }

  // How it looks in the navigation: nothing that is served changes with it.
  if (payload.icon !== undefined) updates.icon = parseIcon(payload.icon);
  // Who may read it. The document is the same either way, so its ETag is too.
  const visibility = parseVisibility(payload.visibility);
  if (visibility !== undefined) updates.visibility = visibility;

  if (Object.keys(updates).length === 0) throw badRequest("Nothing to update.");

  updates.updatedAt = Date.now();
  try {
    const [updated] = await db
      .update(variants)
      .set({
        ...updates,
        // Counted by the database, not from the row read above: two edits
        // that overlap must end up with two different versions, or the
        // later one would be served under the earlier one's ETag, from the
        // earlier one's stored output.
        ...(served ? { revision: sql`${variants.revision} + 1` } : {}),
      })
      .where(eq(variants.id, variant.id))
      .returning();
    if (!updated) throw notFound("Variant");
    return c.json(variantToApi(updated, project, urlPrefix(c)));
  } catch (error) {
    if (isUniqueViolation(error)) throw takenError(String(updates.slug));
    throw error;
  }
});

variantRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const { variant } = await findVariant(db, c.var.organizationId, c.req.param("id"));
  await db.delete(variants).where(eq(variants.id, variant.id));
  return c.json({ ok: true });
});
