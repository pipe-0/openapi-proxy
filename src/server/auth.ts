import type { BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
// The "minimal" entry leaves out the bundled Kysely query builder, which the Drizzle adapter does not need.
import { betterAuth } from "better-auth/minimal";
import { organization as organizationPlugin } from "better-auth/plugins";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import { z } from "zod";
import type { KeyAccess } from "../shared/access";
import { createDb, type Db } from "./db/client";
import * as schema from "./db/schema";
import { sendEmail } from "./email";
import type { AppContext, Env } from "./env";
import { forbidden } from "./errors";
import { randomToken } from "./id";
import { bearerCredential, type KeyPrincipal, principalForKey } from "./keys";
import { sellsPlans } from "./plans";

/**
 * Who is signed in, and which organization they act for.
 *
 * Sessions, users and organizations are better-auth's. Google is the sign-in
 * method; set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. ADMIN_PASSWORD adds a
 * second door, a single built-in admin, for local development, tests and
 * self-hosting without a Google client. Either way the result is the same: a
 * user with a session and an organization, which is all the rest of the
 * server ever looks at.
 */

/**
 * Everything better-auth serves lives under this path, including the redirect
 * URI to register with Google: `<origin>/api/auth/callback/google`.
 */
const AUTH_BASE_PATH = "/api/auth";
const ADMIN_EMAIL = "admin@openapi-proxy.local";
const ADMIN_METHOD = "admin-password";

/** The built-in admin's password can be tried this often per window. */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 30_000;

/** The values in .env.example. Convenient on a laptop, unacceptable anywhere else. */
const EXAMPLE_VALUES = { AUTH_SECRET: "dev-secret-change-me", ADMIN_PASSWORD: "admin" };
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function signInMethods(env: Env): { google: boolean; password: boolean } {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    password: Boolean(env.ADMIN_PASSWORD),
  };
}

/**
 * Why this deployment cannot sign anyone in, if it cannot. A deployment that
 * still has the example secrets counts as unconfigured unless it runs on
 * localhost, so copying the example file can never expose a real instance.
 */
export function configurationProblem(
  env: Env,
  requestUrl: string,
): "missing" | "example-values" | undefined {
  const methods = signInMethods(env);
  if (!env.AUTH_SECRET || (!methods.google && !methods.password)) return "missing";
  const usesExample =
    env.AUTH_SECRET === EXAMPLE_VALUES.AUTH_SECRET ||
    env.ADMIN_PASSWORD === EXAMPLE_VALUES.ADMIN_PASSWORD;
  if (usesExample && !LOCAL_HOSTS.has(new URL(requestUrl).hostname)) return "example-values";
  return undefined;
}

const NOT_CONFIGURED = {
  missing:
    "Sign-in is not configured. Set AUTH_SECRET and either the Google client or ADMIN_PASSWORD.",
  "example-values":
    "This deployment still uses the example secrets. Set your own AUTH_SECRET and ADMIN_PASSWORD.",
};

/** `ALLOWED_EMAILS`: addresses and domains that may sign in. Empty allows everyone. */
function isAllowed(email: string, allowList: string | undefined): boolean {
  const entries = (allowList ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (entries.length === 0) return true;
  const address = email.toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return entries.some((entry) => (entry.includes("@") ? entry === address : entry === domain));
}

/** An open invitation is permission to come in: on a closed instance, inviting a colleague is how they get in. */
async function isInvited(db: Db, email: string): Promise<boolean> {
  const invited = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.email, email.toLowerCase()),
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .get();
  return Boolean(invited);
}

/**
 * Whether someone who is already signed in may still use this instance. The
 * allow list is not only a check at the door. A session lasts for weeks and an
 * API key for as long as it exists, so this is asked on every request: taking
 * an address off ALLOWED_EMAILS, or removing someone from a workspace on a
 * closed instance, ends their access with the next request.
 *
 * On an instance without a list, and for everyone who is on it, the first
 * line answers and nothing is read.
 */
async function stillWelcome(
  db: Db,
  env: Env,
  email: string,
  role: Membership["role"] | undefined,
): Promise<boolean> {
  if (isAllowed(email, env.ALLOWED_EMAILS)) return true;
  if (email === ADMIN_EMAIL && env.ADMIN_PASSWORD) return true;
  // Whoever is in someone else's workspace was let in by its owner.
  if (role === "member") return true;
  return isInvited(db, email);
}

/**
 * The same question for a deploy API key, which acts for a workspace and not
 * for a person: the workspace may use this instance for as long as its owner
 * may. Without it, taking someone off the list would leave their pipeline
 * publishing here.
 */
async function workspaceWelcome(db: Db, env: Env, organizationId: string): Promise<boolean> {
  if (isAllowed("", env.ALLOWED_EMAILS)) return true;
  const owner = await db
    .select({ email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.role, "owner")))
    .get();
  return owner ? stillWelcome(db, env, owner.email, "owner") : false;
}

export interface Membership {
  organizationId: string;
  role: "owner" | "member";
}

async function findMembership(db: Db, userId: string): Promise<Membership | undefined> {
  const row = await db
    .select({ organizationId: schema.member.organizationId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .get();
  return (
    row && { organizationId: row.organizationId, role: row.role === "owner" ? "owner" : "member" }
  );
}

/**
 * The workspace a person belongs to. Everyone belongs to exactly one (the
 * database enforces it): the one they were invited into, or one of their own
 * that is created the first time it is needed. Projects belong to workspaces,
 * never to people.
 *
 * This is read from the member table on every request, not from the session.
 * A session lives for weeks; membership can end this minute.
 */
export async function membershipOf(db: Db, userId: string): Promise<Membership> {
  const existing = await findMembership(db, userId);
  if (existing) return existing;
  try {
    return { organizationId: await createWorkspace(db, userId), role: "owner" };
  } catch (error) {
    // Two first requests at once: the other one created it.
    const raced = await findMembership(db, userId);
    if (raced) return raced;
    throw error;
  }
}

async function createWorkspace(db: Db, userId: string): Promise<string> {
  const owner = await db
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .get();
  const name = owner?.name || owner?.email.split("@")[0] || "Personal";
  const organizationId = `org_${randomToken(16)}`;
  const createdAt = new Date();
  await db.batch([
    db.insert(schema.organization).values({
      id: organizationId,
      name,
      slug: `org-${randomToken(12)}`,
      createdAt,
    }),
    db.insert(schema.member).values({
      id: `mem_${randomToken(16)}`,
      organizationId,
      userId,
      role: "owner",
      createdAt,
    }),
  ]);
  return organizationId;
}

/** Constant-time string comparison via digest equality (handles unequal lengths). */
async function sameSecret(candidate: string, actual: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/**
 * Signing in as the built-in admin with ADMIN_PASSWORD. It creates an ordinary
 * better-auth session for an ordinary user, so nothing downstream can tell the
 * two sign-in methods apart. The password can be tried five times in 30
 * seconds; after that, attempts are refused without being looked at.
 */
function adminPassword(db: Db, password: string): BetterAuthPlugin {
  return {
    id: "admin-password",
    endpoints: {
      signInAdminPassword: createAuthEndpoint(
        "/sign-in/admin-password",
        { method: "POST", body: z.object({ password: z.string().min(1).max(1000) }) },
        async (ctx) => {
          const now = Date.now();
          const { loginThrottle } = schema;
          // The attempt is counted before it is looked at, in one statement.
          // Of forty guesses sent at the same moment, each gets its own
          // number, and the sixth and later are refused unseen. Reading the
          // counter first and writing it afterwards would let all forty pass.
          const windowOver = sql`${loginThrottle.lastFailureAt} <= ${now - ATTEMPT_WINDOW_MS}`;
          const [attempt] = await db
            .insert(loginThrottle)
            .values({ id: 1, failures: 1, lastFailureAt: now })
            .onConflictDoUpdate({
              target: loginThrottle.id,
              set: {
                failures: sql`case when ${windowOver} then 1 else ${loginThrottle.failures} + 1 end`,
                // When the current window began.
                lastFailureAt: sql`case when ${windowOver} then ${now} else ${loginThrottle.lastFailureAt} end`,
              },
            })
            .returning();
          if (!attempt || attempt.failures > MAX_ATTEMPTS) {
            const began = attempt?.lastFailureAt ?? now;
            const seconds = Math.max(1, Math.ceil((began + ATTEMPT_WINDOW_MS - now) / 1000));
            throw new APIError("TOO_MANY_REQUESTS", {
              message: `Too many attempts. Try again in ${seconds}s.`,
            });
          }

          if (!(await sameSecret(ctx.body.password, password))) {
            throw new APIError("UNAUTHORIZED", { message: "Incorrect password." });
          }
          await db
            .update(loginThrottle)
            .set({ failures: 0, lastFailureAt: 0 })
            .where(eq(loginThrottle.id, 1));

          const { internalAdapter } = ctx.context;
          const existing = await internalAdapter.findUserByEmail(ADMIN_EMAIL);
          const user =
            existing?.user ??
            (await internalAdapter.createUser(
              { email: ADMIN_EMAIL, name: "Admin", emailVerified: true },
              { method: ADMIN_METHOD },
            ));
          const session = await internalAdapter.createSession(user.id);
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not start a session." });
          }
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ok: true });
        },
      ),
    },
  };
}

export function createAuth(
  env: Env,
  db: Db,
  origin: string,
  /** Run something after the response is on its way. Without it, it is waited for. */
  defer?: (work: Promise<unknown>) => void,
) {
  const methods = signInMethods(env);
  return betterAuth({
    appName: "openapi-proxy",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    trustedOrigins: [origin],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    socialProviders: methods.google
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID as string,
            clientSecret: env.GOOGLE_CLIENT_SECRET as string,
            prompt: "select_account",
          },
        }
      : {},
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // Most requests are answered from a signed cookie instead of a database read.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    advanced: {
      cookiePrefix: "openapi-proxy",
      useSecureCookies: origin.startsWith("https:"),
    },
    // The built-in limiter keeps its counters in memory, which means nothing
    // across Worker isolates. The password endpoint has its own, in D1.
    rateLimit: { enabled: false },
    user: {
      // The allow list is checked when an account is created and again on
      // every Google sign-in, against the email Google reports at that moment.
      validateUserInfo: async ({ user, source }) => {
        if (source.method === ADMIN_METHOD) return;
        const email = String(user.email ?? "").toLowerCase();
        if (isAllowed(email, env.ALLOWED_EMAILS)) return;
        // Being invited into a workspace is permission to sign in. The address
        // has to be one the provider vouches for.
        if (user.emailVerified === false) {
          return { error: "not_allowed", errorDescription: "This email address is not verified." };
        }
        if (await isInvited(db, email)) return;
        return {
          error: "not_allowed",
          errorDescription: "This account is not allowed to sign in here.",
        };
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const told = announceSignUp(env, origin, user);
            if (defer) defer(told);
            else await told;
          },
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              activeOrganizationId: (await membershipOf(db, session.userId)).organizationId,
            },
          }),
        },
      },
    },
    plugins: [
      // Used for its data model and the session field. Its HTTP endpoints are
      // not reachable (see index.ts): members and invitations go through
      // routes/workspace.ts, where "one workspace per person" is enforced.
      organizationPlugin({ allowUserToCreateOrganization: false }),
      ...(env.ADMIN_PASSWORD ? [adminPassword(db, env.ADMIN_PASSWORD)] : []),
    ],
  });
}

/**
 * Tell whoever runs the service that someone signed up. Only where there is a
 * service to run: an instance that sells plans (CONTACT_EMAIL), that can send
 * email, and that is not someone's own machine. A self-hosted instance tells
 * nobody, and neither does the built-in admin signing in for the first time.
 */
async function announceSignUp(
  env: Env,
  origin: string,
  user: { name: string; email: string },
): Promise<void> {
  const to = env.CONTACT_EMAIL?.trim();
  if (!to || !sellsPlans(env) || user.email === ADMIN_EMAIL) return;
  if (LOCAL_HOSTS.has(new URL(origin).hostname)) return;
  // Never throws: a message that cannot be sent must not get in the way of signing up.
  await sendEmail(env, {
    to,
    subject: `New sign-up: ${user.email}`,
    paragraphs: [`${user.name} (${user.email}) signed up.`],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** The auth instance for this request. Built once per request, on first use. */
export function authFor(c: Context<AppContext>): Auth {
  const existing = c.get("auth");
  if (existing) return existing;
  const auth = createAuth(c.env, createDb(c.env.DB), new URL(c.req.url).origin, (work) =>
    c.executionCtx.waitUntil(work),
  );
  c.set("auth", auth);
  return auth;
}

/** The answer to a bearer credential that stands for no one. */
export function keyRefused(c: Context<AppContext>): Response {
  c.header("www-authenticate", "Bearer");
  return c.json({ code: "unauthorized", error: "This API key is not valid." }, 401);
}

/** A key used for something its kind is not for. */
export function wrongKey(c: Context<AppContext>, access: KeyAccess): Response {
  return c.json(
    {
      code: "forbidden",
      error:
        access === "read"
          ? "This is a user API key: it reads private variants and does nothing else."
          : "This is a deploy API key: it applies a definition (PUT /api/projects/<slug>) and does nothing else.",
    },
    403,
  );
}

/**
 * Who the API key in a request stands for, or undefined if it stands for no
 * one: not a key, revoked, a user API key made by someone who has left the
 * workspace or may no longer sign in here, or a deploy API key of a
 * workspace whose owner may not. The one place a key is
 * accepted, for deploys and for the readers of private variants alike.
 */
export async function keyPrincipal(
  c: Context<AppContext>,
  db: Db,
  credential: string,
): Promise<KeyPrincipal | undefined> {
  const principal = await principalForKey(db, credential, Date.now());
  if (!principal) return undefined;
  const welcome = principal.user
    ? await stillWelcome(db, c.env, principal.user.email, principal.user.role)
    : await workspaceWelcome(db, c.env, principal.organizationId);
  if (!welcome) return undefined;
  if (principal.touch) c.executionCtx.waitUntil(principal.touch());
  return principal;
}

/** The one request a deploy API key may make: apply a definition to a project. */
export const isApply = (c: Context) =>
  c.req.method === "PUT" && /^\/api\/projects\/[^/]+$/.test(new URL(c.req.url).pathname);

/**
 * Auth middleware for the API: the one place a request gets its principal.
 * There are two doors, and a request goes through exactly one of them.
 *
 * A request with an `Authorization: Bearer` header is authenticated by that
 * API key and nothing else. Its cookies are never looked at, so adding a bogus
 * key to a request cannot borrow a session (which is also why the CSRF
 * check, a protection for cookies, can be skipped for these requests).
 *
 * Every other request needs a session cookie, as a browser has.
 *
 * A session stands for a person in a workspace. A deploy API key stands for
 * the workspace and may do one thing, apply a definition, so every other
 * route can count on a person. A user API key is not for the API at all.
 */
export async function requireSession(
  c: Context<AppContext>,
  next: Next,
): Promise<Response | undefined> {
  const problem = configurationProblem(c.env, c.req.url);
  if (problem) return c.json({ code: "not-configured", error: NOT_CONFIGURED[problem] }, 503);

  const db = createDb(c.env.DB);
  const credential = bearerCredential(c.req.header("authorization"));
  if (credential !== undefined) {
    const principal = await keyPrincipal(c, db, credential);
    if (!principal) return keyRefused(c);
    if (principal.access !== "deploy" || !isApply(c)) return wrongKey(c, principal.access);
    c.set("organizationId", principal.organizationId);
    c.set("actor", { kind: "key", id: principal.keyId, name: principal.name });
    c.set("via", "key");
    await next();
    return;
  }

  const { headers, response } = await authFor(c).api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  if (!response) return c.json({ code: "unauthorized", error: "Not signed in." }, 401);

  const { user } = response;
  const existing = await findMembership(db, user.id);
  if (!(await stillWelcome(db, c.env, user.email, existing?.role))) {
    return c.json(
      { code: "unauthorized", error: "This account is not allowed to sign in here." },
      401,
    );
  }
  const membership = existing ?? (await membershipOf(db, user.id));
  c.set("user", { id: user.id, name: user.name, email: user.email, image: user.image });
  c.set("organizationId", membership.organizationId);
  c.set("role", membership.role);
  c.set("actor", { kind: "person", id: user.id, name: user.name });
  c.set("via", "session");

  await next();
  for (const cookie of headers.getSetCookie()) c.res.headers.append("set-cookie", cookie);
}

/**
 * For the routes that decide who is in a workspace and what may act for it:
 * members, invitations and the API keys themselves. A key works with projects
 * and variants. If it could also invite someone or make another key,
 * revoking it would not end the access it gave.
 */
export async function sessionOnly(c: Context<AppContext>, next: Next): Promise<void> {
  if (c.var.via !== "session") {
    throw forbidden("Sign in to manage a workspace.");
  }
  await next();
}
