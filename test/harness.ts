import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, vi } from "vitest";
import worker from "../src/server/index";

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

export interface ApiSource {
  id: string;
  name: string;
  url: string;
  headerNames: string[];
  pathPrefix: string | null;
  versionUrl: string | null;
  lastKnownVersion: string | null;
  versionMismatchAt: number | null;
  validator: "etag" | "last-modified" | null;
  operations: number;
  lastStatus: "ok" | "error";
  lastError: string | null;
}

export interface ApiProject {
  id: string;
  name: string;
  slug: string;
  specVersion: string;
  /** The documents it is assembled from. The first is the main one. */
  sources: ApiSource[];
  opIndex: Array<{ key: string; fingerprint?: string; source?: string }>;
  notes: Array<{ kind: string; source: string } & Record<string, unknown>>;
  lastStatus: "ok" | "error";
  lastError: string | null;
  bodyBytes: number;
}

export interface ApiVariant {
  id: string;
  slug: string;
  path: string;
  url: string;
  keptOperations: number;
  drift: {
    missingSelectedOperations: string[];
    newOperations: string[];
    acknowledged: string[];
  };
}

export async function createProject(
  cookie: string,
  body: Record<string, unknown> = { url: SPEC_URL },
): Promise<ApiProject> {
  const response = await call("/api/projects", json("POST", body, cookie));
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

export async function createVariant(
  cookie: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<ApiVariant> {
  const response = await call(
    "/api/variants",
    json(
      "POST",
      {
        projectId,
        name: "Public",
        selection: { mode: "include", operations: [], tags: ["pets"] },
        ...overrides,
      },
      cookie,
    ),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

/** A project with one variant serving the `pets` tag, ready to be requested. */
export async function publish(selection?: object) {
  const cookie = await login();
  serveSpec();
  const project = await createProject(cookie);
  const variant = await createVariant(cookie, project.id, selection ? { selection } : {});
  return { cookie, project, variant };
}

/** The project's main source, which most tests are about. */
export const mainSource = (project: ApiProject): ApiSource => project.sources[0] as ApiSource;

/** Change the settings of a project's main source. */
export const patchSource = (cookie: string, project: ApiProject, body: unknown, bindings = {}) =>
  call(
    `/api/projects/${project.id}/sources/${mainSource(project).id}`,
    json("PATCH", body, cookie),
    bindings,
  );

export const sql = (query: string, ...params: unknown[]) =>
  env.DB.prepare(query)
    .bind(...params)
    .run();

// ---- API tokens ----

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

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  createdBy: string;
  yours: boolean;
  /** Only in the response that created it. */
  token?: string;
}

/** Create an API token as the signed-in person and return it, including the token itself. */
export async function createToken(
  cookie: string,
  name = "CI",
): Promise<ApiToken & { token: string }> {
  const response = await call("/api/workspace/tokens", json("POST", { name }, cookie));
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

/** Headers for a request authenticated by a token. */
export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
