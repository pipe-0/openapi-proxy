import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { isKeyAccess } from "../../shared/access";
import { GUARDS } from "../../shared/plans";
import { createDb } from "../db/client";
import { apiKeys, projects, user, variants } from "../db/schema";
import type { AppContext } from "../env";
import { ApiError, badRequest, forbidden, notFound, readJson } from "../errors";
import { randomToken } from "../id";
import { generateKey } from "../keys";
import { positionOf } from "../limits";

/**
 * The workspace's API keys, of both kinds. Anyone in the workspace sees which
 * exist. These routes take a signed-in person, never a key (see
 * `sessionOnly`, applied where they are mounted).
 *
 * A deploy API key is the workspace's: only its owner makes and revokes one.
 * A user API key is its maker's: anyone makes their own, and revokes it.
 */
export const keyRoutes = new Hono<AppContext>();

/** A guard against runaway creation, not a pricing plan. */
const MAX_KEYS_PER_WORKSPACE = GUARDS.apiKeys;

keyRoutes.get("/", async (c) => {
  const rows = await createDb(c.env.DB)
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      access: apiKeys.access,
      makerId: apiKeys.createdBy,
      createdBy: user.name,
      project: projects.slug,
      variant: variants.slug,
    })
    .from(apiKeys)
    .leftJoin(user, eq(user.id, apiKeys.createdBy))
    .leftJoin(variants, eq(variants.id, apiKeys.variantId))
    .leftJoin(projects, eq(projects.id, variants.projectId))
    .where(eq(apiKeys.organizationId, c.var.organizationId))
    .orderBy(apiKeys.createdAt);
  return c.json(
    rows.map(({ makerId, project, variant, ...key }) => ({
      ...key,
      /** For a user API key that reads one variant: which. Null: every private variant, or not a user API key. */
      variant: project && variant ? { project, variant } : null,
      yours: makerId === c.var.user.id,
    })),
  );
});

keyRoutes.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const payload = await readJson(c);
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name === "" || name.length > 60) throw badRequest("name must be 1 to 60 characters.");

  const { access } = payload;
  if (!isKeyAccess(access)) throw badRequest('access must be "deploy" or "read".');
  if (access === "deploy" && c.var.role !== "owner") {
    throw forbidden("Only the owner of the workspace makes deploy API keys.");
  }

  // A user API key says what it reads: one variant of this workspace, or null
  // for every private one. Said, not assumed: a field that is left out or
  // misspelled must not come to mean "all of them".
  let variantId: string | null = null;
  let scope: { project: string; variant: string } | null = null;
  if (access === "read") {
    if (payload.variant === undefined) {
      throw badRequest(
        'A user API key needs "variant": { "project": "<slug>", "variant": "<slug>" } for the one variant it reads, or null for every private variant.',
      );
    }
    if (payload.variant !== null) {
      const wanted = payload.variant as { project?: unknown; variant?: unknown };
      const found =
        typeof wanted === "object" &&
        typeof wanted.project === "string" &&
        typeof wanted.variant === "string"
          ? await db
              .select({ id: variants.id })
              .from(variants)
              .innerJoin(projects, eq(projects.id, variants.projectId))
              .where(
                and(
                  eq(projects.slug, wanted.project),
                  eq(variants.slug, wanted.variant),
                  eq(projects.organizationId, c.var.organizationId),
                ),
              )
              .get()
          : undefined;
      if (!found) throw notFound("Variant");
      variantId = found.id;
      scope = { project: wanted.project as string, variant: wanted.variant as string };
    }
  } else if (payload.variant !== undefined && payload.variant !== null) {
    throw badRequest("Only a user API key is for one variant.");
  }

  const { key, keyHash, prefix } = await generateKey();
  const row = {
    id: `key_${randomToken(12)}`,
    organizationId: c.var.organizationId,
    createdBy: c.var.user.id,
    name,
    keyHash,
    prefix,
    access,
    variantId,
    createdAt: Date.now(),
  };
  await db.insert(apiKeys).values(row);
  const ofWorkspace = eq(apiKeys.organizationId, c.var.organizationId);
  if ((await positionOf(db, apiKeys, row.id, ofWorkspace)) > MAX_KEYS_PER_WORKSPACE) {
    await db.delete(apiKeys).where(eq(apiKeys.id, row.id));
    throw new ApiError(
      409,
      "limit-reached",
      `A workspace can have up to ${MAX_KEYS_PER_WORKSPACE} keys. Revoke one you no longer use.`,
    );
  }

  // The only response that ever contains the key itself.
  return c.json(
    {
      id: row.id,
      name,
      prefix,
      createdAt: row.createdAt,
      lastUsedAt: null,
      access,
      variant: scope,
      createdBy: c.var.user.name,
      yours: true,
      key,
    },
    201,
  );
});

/** Revoke a key. A deploy API key: the owner. A user API key: whoever made it, or the owner. */
keyRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const key = await db
    .select({ id: apiKeys.id, makerId: apiKeys.createdBy, access: apiKeys.access })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.organizationId, c.var.organizationId)))
    .get();
  if (!key) throw notFound("Key");
  if (c.var.role !== "owner") {
    if (key.access === "deploy") {
      throw forbidden("Only the owner of the workspace revokes deploy API keys.");
    }
    if (key.makerId !== c.var.user.id) {
      throw forbidden("Only the owner of the workspace can revoke someone else's key.");
    }
  }
  await db.delete(apiKeys).where(eq(apiKeys.id, key.id));
  return c.json({ ok: true });
});
