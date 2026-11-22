import { and, eq } from "drizzle-orm";
import type { KeyAccess } from "../shared/access";
import { sha256Hex } from "./codec";
import type { Db } from "./db/client";
import { apiKeys, member, user } from "./db/schema";

/**
 * API keys: the second door into the API, for scripts and agents, and the
 * way a private variant is read. A key is `oap_` and 40 random characters,
 * sent as `Authorization: Bearer <key>`. It acts as the person who made it,
 * in their workspace, for as long as they are in it. Only its SHA-256 is
 * stored.
 *
 * A key has full access (the API, the MCP endpoint, every private variant)
 * or only reads private variants: all of the workspace's, or one.
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
  organizationId: string;
  role: "owner" | "member";
  user: { id: string; name: string; email: string; image: string | null };
  access: KeyAccess;
  /** For a key that only reads: the one variant it reads, or null for all of the workspace's. */
  variantId: string | null;
  /** Set when `lastUsedAt` is due for an update; run it without holding the response. */
  touch?: () => Promise<unknown>;
}

/**
 * Who a bearer credential stands for, or undefined if it stands for no one:
 * malformed, unknown, revoked, or made by someone who is no longer in the
 * workspace it was made for (the join on `member` is what ends it).
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
    .innerJoin(
      member,
      and(eq(member.userId, apiKeys.userId), eq(member.organizationId, apiKeys.organizationId)),
    )
    .innerJoin(user, eq(user.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, await sha256Hex(credential)))
    .get();
  if (!row) return undefined;

  const due = row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS;
  return {
    keyId: row.keyId,
    organizationId: row.organizationId,
    role: row.role === "owner" ? "owner" : "member",
    user: { id: row.userId, name: row.name, email: row.email, image: row.image },
    access: row.access,
    variantId: row.variantId,
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
  if (principal.organizationId !== variant.organizationId) return false;
  return (
    principal.access === "full" ||
    principal.variantId === null ||
    principal.variantId === variant.id
  );
}
