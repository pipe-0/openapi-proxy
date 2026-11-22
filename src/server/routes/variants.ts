import {
  computeDrift,
  isValidSlug,
  resolveSelection,
  type Selection,
  slugify,
  TARGET_VERSIONS,
  type TargetVersion,
} from "@openapi-proxy/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { GUARDS, PLAN_NAMES } from "../../shared/plans";
import { createDb, type Db } from "../db/client";
import { type ProjectRow, projects, type VariantRow, variants } from "../db/schema";
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

/**
 * The OpenAPI version a variant asks to be served in. Null means the
 * project's own. Conversion exists between 3.0 and 3.1, so a project in
 * another version can only be served as it is.
 */
function readOutputVersion(
  input: unknown,
  project: Pick<ProjectRow, "specVersion">,
): TargetVersion | null {
  if (input === null || input === undefined || input === "") return null;
  const version = TARGET_VERSIONS.find((candidate) => candidate === input);
  if (!version) throw badRequest('outputVersion must be "3.0", "3.1" or null.');
  if (!TARGET_VERSIONS.some((candidate) => candidate === project.specVersion)) {
    throw new ApiError(
      422,
      "cannot-convert",
      `This project's document is OpenAPI ${project.specVersion}, which cannot be converted to ${version} yet.`,
    );
  }
  // Asking for the version the document already has is the same as not asking.
  return version === project.specVersion ? null : version;
}

function variantToApi(
  variant: VariantRow,
  project: Pick<ProjectRow, "slug" | "opIndex">,
  prefix: string,
) {
  const { opsSnapshot, acknowledgedMissingOps, ...rest } = variant;
  const index = asIndex(project.opIndex);
  return {
    ...rest,
    /** Public path of the served document; append .json or .yaml to pin a format. */
    path: `/v/${project.slug}/${variant.slug}`,
    /** The public URL, without a format extension. */
    url: `${prefix}${project.slug}/${variant.slug}`,
    keptOperations: resolveSelection(index, variant.selection).size,
    totalOperations: index.totalOperations,
    drift: {
      ...computeDrift(variant.selection, opsSnapshot, index),
      acknowledged: acknowledgedMissingOps,
    },
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
        outputVersion: readOutputVersion(payload.outputVersion, project),
        opsSnapshot: project.opIndex.map((op) => op.key),
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
  const currentKeys = () => project.opIndex.map((op) => op.key);

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
    // Saving a selection is a review: reset the baseline for "new operations"
    // and forget acknowledgements for operations that are no longer selected.
    updates.opsSnapshot = currentKeys();
    updates.acknowledgedMissingOps = variant.acknowledgedMissingOps.filter((key) =>
      selection.operations.includes(key),
    );
  }

  if (payload.outputVersion !== undefined) {
    const outputVersion = readOutputVersion(payload.outputVersion, project);
    if (outputVersion !== variant.outputVersion) {
      updates.outputVersion = outputVersion;
      served = true;
    }
  }

  if (payload.acknowledgedMissingOps !== undefined) {
    const acknowledged = payload.acknowledgedMissingOps;
    if (!Array.isArray(acknowledged) || !acknowledged.every((key) => typeof key === "string")) {
      throw badRequest("acknowledgedMissingOps must be a list of operation keys.");
    }
    const selected = new Set((updates.selection ?? variant.selection).operations);
    updates.acknowledgedMissingOps = (acknowledged as string[]).filter((key) => selected.has(key));
  }

  if (payload.reviewNewOps === true) updates.opsSnapshot = currentKeys();

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
        ...(served ? { selectionVersion: sql`${variants.selectionVersion} + 1` } : {}),
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
