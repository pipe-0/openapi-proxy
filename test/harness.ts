import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  ApplyResult,
  ProjectDefinition,
  ProjectView,
  VariantDefinition,
} from "@openapi-proxy/core";
import { afterEach, beforeAll, expect, vi } from "vitest";
import worker from "../src/server/index";
import { scheduled } from "../src/server/scheduled";

export const ORIGIN = "https://proxy.test";

/**
 * Call the Worker and wait for everything it scheduled with `waitUntil`
 * (background refreshes, cache writes) before returning, so tests observe a
 * settled state. Pass `bindings` to run the request against different secrets.
 */
export async function call(
  path: string,
  init?: RequestInit,
  bindings: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  const request = new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, init);
  // Browsers attach Origin to every same-origin request that can change state.
  if (!["GET", "HEAD"].includes(request.method) && !request.headers.has("origin")) {
    request.headers.set("origin", new URL(request.url).origin);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** One run of the timer, settled like `call`. */
export async function runTimer(bindings: Partial<Cloudflare.Env> = {}): Promise<void> {
  const ctx = createExecutionContext();
  await scheduled({} as ScheduledController, { ...env, ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
}

/** The `Cookie` header a browser would send back after this response. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] as string)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** Body as text. (workerd warns when `.text()` is called on a non-text content type like YAML.) */
export async function textOf(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

// ---- The upstream: everything the Worker fetches from the outside world ----

type Handler = (request: Request) => Response | Promise<Response>;

const handlers = new Map<string, Handler>();
export const upstreamCalls: Array<{ method: string; url: string; headers: Headers }> = [];

/** Answer `METHOD url` with a handler until the end of the test. */
export function upstream(method: "GET" | "HEAD" | "POST", url: string, handler: Handler): void {
  handlers.set(`${method} ${url}`, handler);
}

export function callsTo(method: string, url: string): number {
  return upstreamCalls.filter((c) => c.method === method && c.url === url).length;
}

beforeAll(() => {
  // The Worker runs in the same isolate as the tests, so replacing the global
  // fetch intercepts its outbound requests.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    upstreamCalls.push({ method: request.method, url: request.url, headers: request.headers });
    const handler = handlers.get(`${request.method} ${request.url}`);
    if (!handler) throw new TypeError(`No upstream for ${request.method} ${request.url}`);
    return handler(request);
  });
});

afterEach(() => {
  handlers.clear();
  upstreamCalls.length = 0;
});

// ---- Fixtures ----

export const SPEC_URL = "https://api.example.com/openapi.json";

export const SPEC = {
  openapi: "3.1.0",
  info: { title: "Test API", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        tags: ["pets"],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
      post: { tags: ["pets"], responses: { "201": { description: "created" } } },
    },
    "/internal/flush": {
      post: { tags: ["internal"], responses: { "204": { description: "flushed" } } },
    },
  },
  components: {
    schemas: {
      Pet: { type: "object", properties: { name: { type: "string" } } },
      Secret: { type: "object", properties: { key: { type: "string" } } },
    },
  },
};

export function serveSpec(
  body: unknown = SPEC,
  headers: Record<string, string> = {},
  url = SPEC_URL,
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  upstream(
    "GET",
    url,
    () => new Response(text, { headers: { "content-type": "application/json", ...headers } }),
  );
}

// ---- Admin API helpers ----

/** Sign in as the built-in admin and return the session cookies. */
export async function login(): Promise<string> {
  const response = await call(
    "/api/auth/sign-in/admin-password",
    json("POST", { password: "test-password" }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return cookiesFrom(response);
}

const base64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Walk the whole Google sign-in: ask for the authorization URL, then come back
 * to the redirect URI the way Google would. Only Google's token
 * endpoint is faked. Returns the response to the redirect.
 */
export async function googleCallback(
  profile: { email: string; name?: string; sub?: string },
  bindings: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  const start = await call(
    "/api/auth/sign-in/social",
    json("POST", { provider: "google", callbackURL: "/", errorCallbackURL: "/login" }),
    bindings,
  );
  expect(start.status, await start.clone().text()).toBe(200);
  const authorize = new URL(((await start.json()) as { url: string }).url);
  expect(authorize.origin).toBe("https://accounts.google.com");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
  expect(authorize.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);

  const claims = {
    iss: "https://accounts.google.com",
    aud: env.GOOGLE_CLIENT_ID,
    sub: profile.sub ?? `google-${profile.email}`,
    email: profile.email,
    email_verified: true,
    name: profile.name ?? profile.email.split("@")[0],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  upstream("POST", "https://oauth2.googleapis.com/token", () =>
    Response.json({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
      id_token: `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url(claims)}.signature`,
    }),
  );

  const state = authorize.searchParams.get("state") as string;
  return call(
    `/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: cookiesFrom(start) }, redirect: "manual" },
    bindings,
  );
}

/** Sign in with Google as this person and return the session cookies. */
export async function googleLogin(
  email: string,
  name?: string,
  bindings: Partial<Cloudflare.Env> = {},
): Promise<string> {
  const response = await googleCallback({ email, ...(name ? { name } : {}) }, bindings);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
  return cookiesFrom(response);
}

/** Bindings that turn email on. Pass them to the calls that should be able to send. */
export const MAIL = {
  CLOUDFLARE_EMAIL_TOKEN: "email-token-for-tests",
  CLOUDFLARE_EMAIL_ACCOUNT_ID: "account-for-tests",
  EMAIL_FROM: "openapi-proxy <notify@proxy.test>",
};

/** Where the email provider is asked to send, for the account above. */
export const MAIL_URL = `https://api.cloudflare.com/client/v4/accounts/${MAIL.CLOUDFLARE_EMAIL_ACCOUNT_ID}/email/sending/send`;

export interface SentEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/** Stand in for the email provider until the end of the test, and collect what it is asked to send. */
export function mailbox(): SentEmail[] {
  const sent: SentEmail[] = [];
  upstream("POST", MAIL_URL, async (request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${MAIL.CLOUDFLARE_EMAIL_TOKEN}`);
    const body = (await request.json()) as SentEmail;
    sent.push(body);
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: {
        message_id: `<${sent.length}@proxy.test>`,
        delivered: [],
        queued: [body.to],
        permanent_bounces: [],
        suppressed_recipients: [],
      },
    });
  });
  return sent;
}

export function json(method: string, body: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  };
}

// ---- Projects ----

export type ApiProject = ProjectView;
export type { ApplyResult };

/** A variant as tests use it: where it is in its project, and what the service says about it. */
export type ApiVariant = ApiProject["state"]["variants"][string] & {
  slug: string;
  /** Its public path, without a format extension. */
  path: string;
};

/**
 * A definition to start from: the project `test`, made of the one document
 * at `SPEC_URL`, which the service follows, and no variants yet.
 */
export function definitionOf(more: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return {
    version: 1,
    project: "test",
    sources: [{ url: SPEC_URL, follow: true }],
    variants: {},
    ...more,
  };
}

/** Everything that can go with a definition in a request to apply it. */
export interface ApplyMore {
  documents?: Record<string, { content: string } | { gzip: string }>;
  credentials?: Record<string, Array<{ name: string; value?: string }>>;
  origin?: Record<string, string>;
  ifRevision?: number;
  editInApp?: boolean;
  dryRun?: boolean;
}

const applyPath = (definition: { project?: unknown }, more: ApplyMore) =>
  `/api/projects/${String(definition.project)}${more.dryRun ? "?dryRun=true" : ""}`;
const applyBody = (definition: unknown, { dryRun: _, ...more }: ApplyMore) => ({
  definition,
  ...more,
});

/** Apply a definition as the signed-in person, the way the app does. */
export function apply(
  cookie: string,
  definition: ProjectDefinition | Record<string, unknown>,
  more: ApplyMore = {},
  bindings: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  return call(
    applyPath(definition, more),
    json("PUT", applyBody(definition, more), cookie),
    bindings,
  );
}

/** Apply a definition with a deploy API key, the way `openapi-proxy deploy` does. */
export function deploy(
  key: string,
  definition: ProjectDefinition | Record<string, unknown>,
  more: ApplyMore = {},
  bindings: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  return callAsProgram(
    applyPath(definition, more),
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer(key) },
      body: JSON.stringify(applyBody(definition, more)),
    },
    bindings,
  );
}

/** The answer to an apply that is expected to go through. */
export async function applied(response: Response | Promise<Response>): Promise<ApplyResult> {
  const settled = await response;
  expect([200, 201], await settled.clone().text()).toContain(settled.status);
  return settled.json();
}

export async function getProject(cookie: string, slug = "test"): Promise<ApiProject> {
  const response = await call(`/api/projects/${slug}`, { headers: { cookie } });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

/** Create the project a definition describes (by default `definitionOf()`), and read it back. */
export async function createProject(
  cookie: string,
  more: Partial<ProjectDefinition> = {},
  extras: ApplyMore = {},
): Promise<ApiProject> {
  const definition = definitionOf(more);
  const result = await applied(apply(cookie, definition, extras));
  expect(result.created).toBe(true);
  return getProject(cookie, definition.project);
}

/** Change a project's definition and apply it, like a save in the app. */
export async function edit(
  cookie: string,
  slug: string,
  change: (definition: ProjectDefinition) => ProjectDefinition | undefined,
  more: ApplyMore = {},
  bindings: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  const project = await getProject(cookie, slug);
  const definition = change(project.definition) ?? project.definition;
  return apply(cookie, definition, { ifRevision: project.state.revision, ...more }, bindings);
}

export const variantOf = (project: ApiProject, slug: string): ApiVariant => {
  const state = project.state.variants[slug];
  if (!state) throw new Error(`The project has no variant ${slug}.`);
  return { ...state, slug, path: `/v/${project.definition.project}/${slug}` };
};

/** Add a variant to a project (by default `public`, serving the `pets` tag) and return it. */
export async function createVariant(
  cookie: string,
  project: string | ApiProject,
  slug = "public",
  variant: VariantDefinition = { include: { tags: ["pets"] } },
): Promise<ApiVariant> {
  const projectSlug = typeof project === "string" ? project : project.definition.project;
  await applied(
    edit(cookie, projectSlug, (definition) => ({
      ...definition,
      variants: { ...definition.variants, [slug]: variant },
    })),
  );
  return variantOf(await getProject(cookie, projectSlug), slug);
}

/**
 * A project with one variant serving the `pets` tag, ready to be requested.
 * With `serve: false` the source is whatever the test set up before.
 */
export async function publish(
  options: {
    variant?: VariantDefinition;
    serve?: boolean;
    project?: Partial<ProjectDefinition>;
  } = {},
) {
  const cookie = await login();
  if (options.serve !== false) serveSpec();
  await createProject(cookie, {
    variants: { public: options.variant ?? { include: { tags: ["pets"] } } },
    ...options.project,
  });
  const project = await getProject(cookie, options.project?.project ?? "test");
  return { cookie, project, variant: variantOf(project, "public") };
}

/** A document as an apply takes it along. */
export const document = (body: unknown = SPEC) => ({
  content: typeof body === "string" ? body : JSON.stringify(body),
});

export const sql = (query: string, ...params: unknown[]) =>
  env.DB.prepare(query)
    .bind(...params)
    .run();

/** Rows straight from the database. */
export async function rows<T>(query: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(query)
    .bind(...params)
    .all<T>();
  return results;
}

// ---- API keys ----

/**
 * Call the Worker the way a program does: exactly the headers given, and no
 * Origin (which `call` adds to imitate a browser).
 */
export async function callAsProgram(
  path: string,
  init?: RequestInit,
  bindings: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  const request = new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  createdBy: string | null;
  yours: boolean;
  /** "deploy": applies definitions. "read": reads private variants. */
  access: "deploy" | "read";
  /** For a user API key: the one variant it reads, or null for all of them. */
  variant: { project: string; variant: string } | null;
  /** Only in the response that created it. */
  key?: string;
}

type KeyRequest =
  | { access: "deploy" }
  | { access: "read"; variant: { project: string; variant: string } | null };

/** Create an API key as the signed-in person and return it, including the key itself. */
export async function createKey(
  cookie: string,
  name = "CI",
  more: KeyRequest = { access: "deploy" },
): Promise<ApiKey & { key: string }> {
  const response = await call("/api/workspace/keys", json("POST", { name, ...more }, cookie));
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

/** A user API key that reads every private variant of the workspace, or one. */
export const createReadKey = (
  cookie: string,
  variant: { project: string; variant: string } | null = null,
  name = "Reader",
) => createKey(cookie, name, { access: "read", variant });

/** Headers for a request authenticated by an API key. */
export const bearer = (key: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
});
