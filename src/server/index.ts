import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { PLAN_NAMES } from "../shared/plans";
import {
  authFor,
  configurationProblem,
  isApply,
  requireSession,
  sessionOnly,
  signInMethods,
} from "./auth";
import { createDb } from "./db/client";
import { organization } from "./db/schema";
import { emailConfigured } from "./email";
import type { AppContext } from "./env";
import { errorResponse } from "./errors";
import { bearerCredential } from "./keys";
import { limitsToApi, planOf, sellsPlans } from "./plans";
import { urlPrefix } from "./public-url";
import { charge, REQUEST_COST } from "./rate-limit";
import { keyRoutes } from "./routes/keys";
import { projectRoutes, slugRoutes } from "./routes/projects";
import { invitationRoutes, workspaceRoutes } from "./routes/workspace";
import { serveRoutes } from "./serve";

/**
 * The surfaces of the Worker that are not pages:
 *   /v/*    the variants: public and cacheable, or private and read with a user API key
 *   /api/*  what the app talks to, behind a session (/api/auth/* is better-auth).
 *           One route also takes a deploy API key: PUT /api/projects/<slug>,
 *           which is what `openapi-proxy deploy` sends a definition to.
 * Pages, and the routing between this app and them, are in src/web/server.ts.
 */
const app = new Hono<AppContext>();

app.onError(errorResponse);

app.route("/v", serveRoutes);

/**
 * Requests are refused before they are read into memory when they are larger
 * than they have a use for being. A definition comes with the project's
 * documents (5 MB together, usually sent compressed); nothing else comes
 * close to a megabyte.
 */
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_APPLY_BYTES = 8_000_000;
const tooLarge = (c: Context) =>
  c.json({ code: "too-large", error: "The request is too large." }, 413);
const requestLimit = bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: tooLarge });
const applyLimit = bodyLimit({ maxSize: MAX_APPLY_BYTES, onError: tooLarge });
app.use("/api/*", (c, next) => (isApply(c) ? applyLimit(c, next) : requestLimit(c, next)));

const api = new Hono<AppContext>();

api.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
});
// Session cookies are SameSite=Lax already; this also rejects cross-origin form posts outright.
// It is a protection for cookies. A request that presents an API key is
// authenticated by that key alone (see requireSession), comes from a
// program that sends no Origin, and is let through. better-auth's own routes
// only know cookies, so they always get the check.
const cookieCsrf = csrf();
api.use("*", (c, next) => {
  const byKey = bearerCredential(c.req.header("authorization")) !== undefined;
  return byKey && !c.req.path.startsWith("/api/auth/") ? next() : cookieCsrf(c, next);
});

/** What the sign-in page needs before anyone is signed in. */
api.get("/auth-config", (c) => {
  const problem = configurationProblem(c.env, c.req.url);
  return c.json({
    configured: !problem,
    ...(problem ? { problem } : {}),
    methods: signInMethods(c.env),
    /** A public service has terms and a privacy policy to point to; a private instance does not. */
    legal: c.env.PUBLIC_SITE === "true",
  });
});

// better-auth's organization plugin brings its own endpoints for creating
// organizations, switching between them, inviting and accepting. None of them
// know that a person has exactly one workspace here, so none are reachable;
// routes/workspace.ts is the only way to change who is in what.
api.all("/auth/organization/*", (c) => c.json({ code: "not-found", error: "Not found." }, 404));

api.on(["GET", "POST"], "/auth/*", async (c) => {
  if (configurationProblem(c.env, c.req.url)) {
    return c.json({ code: "not-configured", error: "Sign-in is not configured." }, 503);
  }
  return authFor(c).handler(c.req.raw);
});

// Everything below requires a principal: a session, or for the one route
// that takes it, a deploy API key.
api.use("*", requireSession);
// And is charged to that principal's workspace (see rate-limit.ts).
api.use("*", charge(REQUEST_COST));

/** Who is signed in, what they belong to, and what that workspace may do. */
api.get("/me", async (c) => {
  const db = createDb(c.env.DB);
  const [org, { plan, limits }] = await Promise.all([
    db
      .select({
        id: organization.id,
        name: organization.name,
        defaultVisibility: organization.defaultVisibility,
      })
      .from(organization)
      .where(eq(organization.id, c.var.organizationId))
      .get(),
    planOf(db, c.env, c.var.organizationId),
  ]);
  return c.json({
    user: c.var.user,
    workspace: { id: c.var.organizationId, name: org?.name ?? "" },
    role: c.var.role,
    plan,
    planName: PLAN_NAMES[plan],
    /** False on an instance that sells no plans: nothing about them is shown. */
    plansEnabled: sellsPlans(c.env),
    limits: limitsToApi(limits),
    emailConfigured: emailConfigured(c.env),
    /** Who may read a variant when neither it nor its project says. */
    defaultVisibility: org?.defaultVisibility ?? "public",
    /** Everything before a project's slug in its public URLs, for a project that is not there yet. */
    urlPrefix: urlPrefix(c),
  });
});

api.route("/projects", projectRoutes);
api.route("/slugs", slugRoutes);

// A deploy API key never gets past `requireSession` for these; said again
// here, because they are about who is in the workspace.
api.use("/workspace/*", sessionOnly);
api.use("/invitations/*", sessionOnly);
api.route("/workspace/keys", keyRoutes);
api.route("/workspace", workspaceRoutes);
api.route("/invitations", invitationRoutes);

app.route("/api", api);

// Only /v/* and /api/* are sent here (see src/web/server.ts), so
// anything that falls through is an unknown path.
app.notFound((c) => c.json({ code: "not-found", error: "Not found." }, 404));

export default app;
