import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { PLAN_NAMES } from "../shared/plans";
import { authFor, configurationProblem, requireSession, sessionOnly, signInMethods } from "./auth";
import { createDb } from "./db/client";
import { organization } from "./db/schema";
import { emailConfigured } from "./email";
import type { AppContext } from "./env";
import { errorResponse } from "./errors";
import { bearerCredential } from "./keys";
import { limitsToApi, planOf, sellsPlans } from "./plans";
import { charge, REQUEST_COST } from "./rate-limit";
import { keyRoutes } from "./routes/keys";
import { projectRoutes } from "./routes/projects";
import { variantRoutes } from "./routes/variants";
import { invitationRoutes, workspaceRoutes } from "./routes/workspace";
import { serveRoutes } from "./serve";

/**
 * The surfaces of the Worker that are not pages:
 *   /v/*    public, cacheable, unauthenticated: the filtered documents
 *   /api/*  the API, behind a session or an API key (/api/auth/* is better-auth)
 * Pages, and the routing between this app and them, are in src/web/server.ts.
 */
const app = new Hono<AppContext>();

app.onError(errorResponse);

app.route("/v", serveRoutes);

/**
 * The largest request this API has a use for is a selection that lists every
 * operation of a large API by name, a few hundred kilobytes. Anything bigger
 * is refused before it is read into memory.
 */
const MAX_REQUEST_BYTES = 1_000_000;
const requestLimit = bodyLimit({
  maxSize: MAX_REQUEST_BYTES,
  onError: (c) => c.json({ code: "too-large", error: "The request is too large." }, 413),
});
app.use("/api/*", requestLimit);

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

// Everything below requires a principal: a session, or an API key.
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
    /** Whether a new variant starts public or private. */
    defaultVisibility: org?.defaultVisibility ?? "public",
  });
});

// What an API key can reach: projects and variants.
api.route("/projects", projectRoutes);
api.route("/variants", variantRoutes);

// Who is in the workspace, and which API keys act for it, takes a person.
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
