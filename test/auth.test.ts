import { describe, expect, it } from "vitest";
import {
  type ApiProject,
  apply,
  call,
  cookiesFrom,
  createProject,
  getProject,
  googleCallback,
  googleLogin,
  json,
  login,
  ORIGIN,
  serveSpec,
  sql,
  upstreamCalls,
} from "./harness";

const me = async (cookie: string) =>
  (await (await call("/api/me", { headers: { cookie } })).json()) as {
    user: { email: string; name: string };
    workspace: { id: string; name: string };
  };

describe("the admin API", () => {
  it("is closed without a session", async () => {
    expect((await call("/api/projects")).status).toBe(401);
    expect((await call("/api/workspace/keys")).status).toBe(401);
    expect((await call("/api/me")).status).toBe(401);
  });

  it("tells the sign-in page which methods exist", async () => {
    expect(await (await call("/api/auth-config")).json()).toEqual({
      configured: true,
      methods: { google: true, password: true },
      legal: false,
    });
    const publicService = await call("/api/auth-config", undefined, { PUBLIC_SITE: "true" });
    expect(await publicService.json()).toMatchObject({ legal: true });
    const googleOnly = await call("/api/auth-config", undefined, { ADMIN_PASSWORD: "" });
    expect(await googleOnly.json()).toMatchObject({ methods: { google: true, password: false } });
    const nothing = await call("/api/auth-config", undefined, {
      ADMIN_PASSWORD: "",
      GOOGLE_CLIENT_ID: "",
    });
    expect(await nothing.json()).toMatchObject({ configured: false, problem: "missing" });
  });

  it("never lets the browser cache its responses", async () => {
    const response = await call("/api/projects", { headers: { cookie: await login() } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses cross-origin form posts", async () => {
    const response = await call("/api/projects", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: JSON.stringify({ url: "https://example.com/openapi.json" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("signing in with Google", () => {
  it("creates the user, an organization for them, and a session", async () => {
    const response = await googleCallback({ email: "ada@example.com", name: "Ada Lovelace" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");

    // The code was exchanged with the client secret, at Google.
    const exchange = upstreamCalls.find((c) => c.url === "https://oauth2.googleapis.com/token");
    expect(exchange?.method).toBe("POST");

    const session = cookiesFrom(response);
    expect(response.headers.getSetCookie().join("\n")).toMatch(/HttpOnly/i);
    expect(response.headers.getSetCookie().join("\n")).toMatch(/Secure/i);

    const who = await me(session);
    expect(who.user).toMatchObject({ email: "ada@example.com", name: "Ada Lovelace" });
    expect(who.workspace.name).toBe("Ada Lovelace");
    expect(who.workspace.id).toMatch(/^org_/);

    // Signing in again is the same person in the same organization.
    const again = await me(await googleLogin("ada@example.com"));
    expect(again.workspace.id).toBe(who.workspace.id);
    expect((await sql("SELECT count(*) AS n FROM user")).results[0]).toEqual({ n: 1 });
  });

  it("signs out", async () => {
    const session = await googleLogin("ada@example.com");
    const out = await call("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: session, "content-type": "application/json" },
      body: "{}",
    });
    expect(out.status).toBe(200);
    // The browser drops the cookies; the server has forgotten the session too.
    expect((await sql("SELECT count(*) AS n FROM session")).results[0]).toEqual({ n: 0 });
  });

  it("honours ALLOWED_EMAILS", async () => {
    const allow = { ALLOWED_EMAILS: "example.org, grace@example.com" };
    for (const email of ["someone@example.org", "grace@example.com"]) {
      const ok = await googleCallback({ email }, allow);
      expect(ok.headers.get("location"), email).toBe("/");
    }
    const refused = await googleCallback({ email: "mallory@example.com" }, allow);
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toContain("/login?error=");
    expect(cookiesFrom(refused)).not.toContain("session_token");
    expect((await sql("SELECT count(*) AS n FROM user")).results[0]).toEqual({ n: 2 });
  });

  it("rejects a callback that did not start here", async () => {
    const forged = await call("/api/auth/callback/google?code=stolen&state=made-up", {
      redirect: "manual",
    });
    expect(cookiesFrom(forged)).not.toContain("session_token");
    expect((await sql("SELECT count(*) AS n FROM user")).results[0]).toEqual({ n: 0 });
  });
});

describe("signing in with the admin password", () => {
  const attempt = (password: string, bindings = {}, origin = ORIGIN) =>
    call(`${origin}/api/auth/sign-in/admin-password`, json("POST", { password }), bindings);

  it("rejects a wrong password and accepts the right one", async () => {
    expect((await attempt("wrong")).status).toBe(401);
    const good = await attempt("test-password");
    expect(good.status).toBe(200);
    const who = await me(cookiesFrom(good));
    expect(who.user.name).toBe("Admin");
    expect(who.workspace.id).toMatch(/^org_/);
  });

  it("locks after repeated failures, even for the right password", async () => {
    for (let i = 0; i < 5; i++) await attempt("wrong");
    expect((await attempt("test-password")).status).toBe(429);
  });

  it("does not exist unless ADMIN_PASSWORD is set", async () => {
    expect((await attempt("", { ADMIN_PASSWORD: "" })).status).toBe(404);
    expect((await attempt("anything", { ADMIN_PASSWORD: "" })).status).toBe(404);
  });

  it("refuses the example secrets anywhere but localhost", async () => {
    const example = { ADMIN_PASSWORD: "admin", AUTH_SECRET: "dev-secret-change-me" };

    const deployed = await call("/api/auth-config", undefined, example);
    expect(await deployed.json()).toMatchObject({ configured: false, problem: "example-values" });
    expect((await attempt("admin", example)).status).toBe(503);

    const local = await attempt("admin", example, "http://localhost:7732");
    expect(local.status).toBe(200);
    // Plain-http localhost is the one place cookies are not marked Secure.
    expect(local.headers.getSetCookie().join("\n")).not.toMatch(/Secure/i);

    // A session minted with the well-known example secret is worthless on a real host.
    const forged = await call(
      "/api/projects",
      { headers: { cookie: cookiesFrom(local) } },
      example,
    );
    expect(forged.status).toBe(503);
  });
});

describe("organizations", () => {
  it("cannot see, change or take over each other's data", async () => {
    const ada = await googleLogin("ada@example.com");
    const grace = await googleLogin("grace@example.org");

    serveSpec();
    const project = await createProject(ada, { variants: { public: {} } });

    const listed = (await (
      await call("/api/projects", { headers: { cookie: grace } })
    ).json()) as ApiProject[];
    expect(listed).toEqual([]);

    for (const [method, path] of [
      ["GET", "/api/projects/test"],
      ["GET", "/api/projects/test/document"],
      ["GET", "/api/projects/test/notifications"],
      ["POST", "/api/projects/test/check"],
      ["DELETE", "/api/projects/test"],
    ] as const) {
      const response = await call(path, { method, headers: { cookie: grace } });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    const credentials = await call(
      "/api/projects/test/credentials",
      json("PUT", { source: "main", headers: [] }, grace),
    );
    expect(credentials.status).toBe(404);
    // Its slug is taken, and saying so gives nothing of it away.
    const taken = await apply(grace, { ...project.definition, name: "mine now" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ code: "slug-taken", error: '"test" is already taken.' });
    const key = await call(
      "/api/workspace/keys",
      json(
        "POST",
        { name: "x", access: "read", variant: { project: "test", variant: "public" } },
        grace,
      ),
    );
    expect(key.status).toBe(404);

    // The same source can be a project in both organizations, under different public names.
    const theirs = await createProject(grace, { project: "test-2" });
    expect(theirs.definition.sources).toEqual(project.definition.sources);

    // Public URLs need no organization: project slugs are unique across the deployment.
    expect((await call("/v/test/public")).status).toBe(200);
    expect((await getProject(ada)).definition).toEqual(project.definition);
  });
});
