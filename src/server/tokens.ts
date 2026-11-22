import { and, eq } from "drizzle-orm";
import { sha256Hex } from "./codec";
import type { Db } from "./db/client";
import { apiTokens, member, user } from "./db/schema";

/**
 * API tokens: the second door into the API, for scripts and agents. A token
 * is `oap_` and 40 random characters, sent as `Authorization: Bearer <token>`.
 * It acts as the person who made it, in their workspace, for as long as they
 * are in it. Only its SHA-256 is stored.
 */
const TOKEN_PREFIX = "oap_";
const TOKEN_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const TOKEN_PATTERN = /^oap_[0-9a-z]{40}$/;
/** How much of a token is kept in the clear, to tell tokens apart in a list. */
const DISPLAY_LENGTH = 8;
/** `lastUsedAt` is a rough "is this still in use", not an access log. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface NewToken {
  token: string;
  tokenHash: string;
  prefix: string;
}

/** A fresh token. The caller shows `token` once and stores the other two. */
export async function generateToken(): Promise<NewToken> {
  let secret = "";
  while (secret.length < 40) {
    for (const byte of crypto.getRandomValues(new Uint8Array(64))) {
      // 252 is the largest multiple of 36 below 256: skipping the rest keeps every character equally likely.
      if (byte < 252 && secret.length < 40) secret += TOKEN_ALPHABET[byte % 36];
    }
  }
  const token = `${TOKEN_PREFIX}${secret}`;
  return { token, tokenHash: await sha256Hex(token), prefix: token.slice(0, DISPLAY_LENGTH) };
}

/**
 * What an `Authorization` header says about tokens: `undefined` when it is
 * not a bearer header at all, otherwise the credential it carries (which may
 * be nonsense).
 */
export function bearerCredential(header: string | undefined): string | undefined {
  // "Bearer" with nothing after it is still a bearer header, carrying an empty credential.
  const match = /^Bearer(?:\s+(.*))?$/i.exec((header ?? "").trim());
  return match ? (match[1] ?? "").trim() : undefined;
}

export interface TokenPrincipal {
  tokenId: string;
  organizationId: string;
  role: "owner" | "member";
  user: { id: string; name: string; email: string; image: string | null };
  /** Set when `lastUsedAt` is due for an update; run it without holding the response. */
  touch?: () => Promise<unknown>;
}

/**
 * Who a bearer credential stands for, or undefined if it stands for no one:
 * malformed, unknown, revoked, or made by someone who is no longer in the
 * workspace it was made for (the join on `member` is what ends it).
 */
export async function principalForToken(
  db: Db,
  credential: string,
  now: number,
): Promise<TokenPrincipal | undefined> {
  if (!TOKEN_PATTERN.test(credential)) return undefined;

  const row = await db
    .select({
      tokenId: apiTokens.id,
      lastUsedAt: apiTokens.lastUsedAt,
      organizationId: apiTokens.organizationId,
      role: member.role,
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(apiTokens)
    .innerJoin(
      member,
      and(eq(member.userId, apiTokens.userId), eq(member.organizationId, apiTokens.organizationId)),
    )
    .innerJoin(user, eq(user.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, await sha256Hex(credential)))
    .get();
  if (!row) return undefined;

  const due = row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS;
  return {
    tokenId: row.tokenId,
    organizationId: row.organizationId,
    role: row.role === "owner" ? "owner" : "member",
    user: { id: row.userId, name: row.name, email: row.email, image: row.image },
    ...(due
      ? {
          touch: () =>
            db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.tokenId)),
        }
      : {}),
  };
}
