import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { GUARDS } from "../../shared/plans";
import { createDb } from "../db/client";
import { apiTokens, user } from "../db/schema";
import type { AppContext } from "../env";
import { ApiError, badRequest, forbidden, notFound, readJson } from "../errors";
import { randomToken } from "../id";
import { positionOf } from "../limits";
import { generateToken } from "../tokens";

/**
 * The workspace's API tokens. Anyone in the workspace sees which exist.
 * These routes take a signed-in person, never another token (see
 * `sessionOnly`, applied where they are mounted).
 */
export const tokenRoutes = new Hono<AppContext>();

/** A guard against runaway creation, not a pricing plan. */
const MAX_TOKENS_PER_WORKSPACE = GUARDS.apiTokens;

tokenRoutes.get("/", async (c) => {
  const rows = await createDb(c.env.DB)
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      userId: apiTokens.userId,
      createdBy: user.name,
    })
    .from(apiTokens)
    .innerJoin(user, eq(user.id, apiTokens.userId))
    .where(eq(apiTokens.organizationId, c.var.organizationId))
    .orderBy(apiTokens.createdAt);
  return c.json(
    rows.map(({ userId, ...token }) => ({ ...token, yours: userId === c.var.user.id })),
  );
});

tokenRoutes.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const payload = await readJson(c);
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name === "" || name.length > 60) throw badRequest("name must be 1 to 60 characters.");

  const { token, tokenHash, prefix } = await generateToken();
  const row = {
    id: `tok_${randomToken(12)}`,
    organizationId: c.var.organizationId,
    userId: c.var.user.id,
    name,
    tokenHash,
    prefix,
    createdAt: Date.now(),
  };
  await db.insert(apiTokens).values(row);
  const ofWorkspace = eq(apiTokens.organizationId, c.var.organizationId);
  if ((await positionOf(db, apiTokens, row.id, ofWorkspace)) > MAX_TOKENS_PER_WORKSPACE) {
    await db.delete(apiTokens).where(eq(apiTokens.id, row.id));
    throw new ApiError(
      409,
      "limit-reached",
      `A workspace can have up to ${MAX_TOKENS_PER_WORKSPACE} tokens. Revoke one you no longer use.`,
    );
  }

  // The only response that ever contains the token itself.
  return c.json(
    {
      id: row.id,
      name,
      prefix,
      createdAt: row.createdAt,
      lastUsedAt: null,
      createdBy: c.var.user.name,
      yours: true,
      token,
    },
    201,
  );
});

/** Revoke a token: your own, or anyone's if you own the workspace. */
tokenRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const token = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(
      and(eq(apiTokens.id, c.req.param("id")), eq(apiTokens.organizationId, c.var.organizationId)),
    )
    .get();
  if (!token) throw notFound("Token");
  if (token.userId !== c.var.user.id && c.var.role !== "owner") {
    throw forbidden("Only the owner of the workspace can revoke someone else's token.");
  }
  await db.delete(apiTokens).where(eq(apiTokens.id, token.id));
  return c.json({ ok: true });
});
