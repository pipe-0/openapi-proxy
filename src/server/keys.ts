import { and, eq } from "drizzle-orm";
import type { KeyAccess } from "../shared/access";
import { sha256Hex } from "./codec";
import type { Db } from "./db/client";
import { apiKeys, member, user } from "./db/schema";

/**
 * API keys. A key is `oap_` and 40 random characters, sent as
 * `Authorization: Bearer <key>`. Only its SHA-256 is stored.
 *
 * A deploy API key applies definitions and belongs to the workspace. A user
 * API key reads private variants (all of the workspace's, or one) and acts
 * for the person who made it, for as long as they are in the workspace.
 */
const KEY_PREFIX = "oap_";
const KEY_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const KEY_PATTERN = /^oap_[0-9a-z]{40}$/;
/** How much of a key is kept in the clear, to tell keys apart in a list. */
const DISPLAY_LENGTH = 8;
/** `lastUsedAt` is a rough "is this still in use", not an access log. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface NewKey {
  key: string;
  keyHash: string;
  prefix: string;
}

/** A fresh key. The caller shows `key` once and stores the other two. */
export async function generateKey(): Promise<NewKey> {
  let secret = "";
  while (secret.length < 40) {
    for (const byte of crypto.getRandomValues(new Uint8Array(64))) {
      // 252 is the largest multiple of 36 below 256: skipping the rest keeps every character equally likely.
      if (byte < 252 && secret.length < 40) secret += KEY_ALPHABET[byte % 36];
    }
  }
  const key = `${KEY_PREFIX}${secret}`;
  return { key, keyHash: await sha256Hex(key), prefix: key.slice(0, DISPLAY_LENGTH) };
}

/**
 * What an `Authorization` header says about keys: `undefined` when it is
 * not a bearer header at all, otherwise the credential it carries (which may
 * be nonsense).
 */
export function bearerCredential(header: string | undefined): string | undefined {
  // "Bearer" with nothing after it is still a bearer header, carrying an empty credential.
  const match = /^Bearer(?:\s+(.*))?$/i.exec((header ?? "").trim());
  return match ? (match[1] ?? "").trim() : undefined;
}

export interface KeyPrincipal {
  keyId: string;
  name: string;
  organizationId: string;
  access: KeyAccess;
  /** For a user API key: the one variant it reads, or null for all of the workspace's. */
  variantId: string | null;
  /** For a user API key: the person it acts for. */
  user?: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: "owner" | "member";
  };
  /** Set when `lastUsedAt` is due for an update; run it without holding the response. */
  touch?: () => Promise<unknown>;
}

/**
 * Who a bearer credential stands for, or undefined if it stands for no one:
 * malformed, unknown, revoked, or a user API key made by someone who is no
 * longer in the workspace it was made for (the join on `member` is what
 * ends it). A deploy API key stands for the workspace itself.
 */
export async function principalForKey(
  db: Db,
  credential: string,
  now: number,
): Promise<KeyPrincipal | undefined> {
  if (!KEY_PATTERN.test(credential)) return undefined;

  const row = await db
    .select({
      keyId: apiKeys.id,
      keyName: apiKeys.name,
      lastUsedAt: apiKeys.lastUsedAt,
      organizationId: apiKeys.organizationId,
      access: apiKeys.access,
      variantId: apiKeys.variantId,
      role: member.role,
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(apiKeys)
    .leftJoin(
      member,
      and(eq(member.userId, apiKeys.createdBy), eq(member.organizationId, apiKeys.organizationId)),
    )
    .leftJoin(user, eq(user.id, member.userId))
    .where(eq(apiKeys.keyHash, await sha256Hex(credential)))
    .get();
  if (!row) return undefined;
  const maker =
    row.userId !== null && row.name !== null && row.email !== null
      ? {
          id: row.userId,
          name: row.name,
          email: row.email,
          image: row.image,
          role: row.role === "owner" ? ("owner" as const) : ("member" as const),
        }
      : undefined;
  if (row.access === "read" && !maker) return undefined;

  const due = row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS;
  return {
    keyId: row.keyId,
    name: row.keyName,
    organizationId: row.organizationId,
    access: row.access,
    variantId: row.variantId,
    ...(row.access === "read" && maker ? { user: maker } : {}),
    ...(due
      ? {
          touch: () => db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.keyId)),
        }
      : {}),
  };
}

/** Whether a key reads a private variant: one of its workspace, with access to it. */
export function reads(
  principal: Pick<KeyPrincipal, "organizationId" | "access" | "variantId">,
  variant: { id: string; organizationId: string },
): boolean {
  if (principal.access !== "read" || principal.organizationId !== variant.organizationId) {
    return false;
  }
  return principal.variantId === null || principal.variantId === variant.id;
}
