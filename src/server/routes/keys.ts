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
 * The workspace's API keys. Anyone in the workspace sees which exist.
 * These routes take a signed-in person, never another key (see
 * `sessionOnly`, applied where they are mounted).
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
      variantId: apiKeys.variantId,
      userId: apiKeys.userId,
      createdBy: user.name,
    })
    .from(apiKeys)
    .innerJoin(user, eq(user.id, apiKeys.userId))
    .where(eq(apiKeys.organizationId, c.var.organizationId))
    .orderBy(apiKeys.createdAt);
  return c.json(rows.map(({ userId, ...key }) => ({ ...key, yours: userId === c.var.user.id })));
});

keyRoutes.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const payload = await readJson(c);
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name === "" || name.length > 60) throw badRequest("name must be 1 to 60 characters.");

  const access = payload.access ?? "full";
  if (!isKeyAccess(access)) throw badRequest('access must be "full" or "read".');
  // A key that only reads says what it reads: one variant of this workspace, or
  // null for every private one. Said, not assumed: a field that is left out or
  // misspelled must not come to mean "all of them".
  if (access === "read" && payload.variantId === undefined) {
    throw badRequest(
      "A key with read access needs variantId: the id of the one variant it reads, or null for every private variant.",
    );
  }
  let variantId: string | null = null;
  if (payload.variantId !== undefined && payload.variantId !== null) {
    if (access !== "read") throw badRequest("Only a key with read access is for one variant.");
    const variant =
      typeof payload.variantId === "string"
        ? await db
            .select({ id: variants.id })
            .from(variants)
            .innerJoin(projects, eq(projects.id, variants.projectId))
            .where(
              and(
                eq(variants.id, payload.variantId),
                eq(projects.organizationId, c.var.organizationId),
              ),
            )
            .get()
        : undefined;
    if (!variant) throw notFound("Variant");
    variantId = variant.id;
  }

  const { key, keyHash, prefix } = await generateKey();
  const row = {
    id: `key_${randomToken(12)}`,
    organizationId: c.var.organizationId,
    userId: c.var.user.id,
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
      variantId,
      createdBy: c.var.user.name,
      yours: true,
      key,
    },
    201,
  );
});

/** Revoke a key: your own, or anyone's if you own the workspace. */
keyRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const key = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.organizationId, c.var.organizationId)))
    .get();
  if (!key) throw notFound("Key");
  if (key.userId !== c.var.user.id && c.var.role !== "owner") {
    throw forbidden("Only the owner of the workspace can revoke someone else's key.");
  }
  await db.delete(apiKeys).where(eq(apiKeys.id, key.id));
  return c.json({ ok: true });
});
