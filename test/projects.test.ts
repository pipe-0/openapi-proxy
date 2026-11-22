import { describe, expect, it } from "vitest";
import {
  type ApiProject,
  call,
  callsTo,
  createProject,
  createVariant,
  googleLogin,
  json,
  login,
  mainSource,
  patchSource,
  publish,
  SPEC,
  SPEC_URL,
  serveSpec,
  sql,
  upstream,
  upstreamCalls,
} from "./harness";

describe("creating a project", () => {
  it("fetches the document, names the project after it and indexes operations", async () => {
    const cookie = await login();
    serveSpec();
    const project = await createProject(cookie);

    expect(project.name).toBe("Test API");
    expect(project.slug).toBe("test");
    expect(project.operations.map((op) => op.key).sort()).toEqual([
      "GET /pets",
      "POST /internal/flush",
      "POST /pets",
    ]);
    expect(project.sources).toHaveLength(1);
    expect(mainSource(project)).toMatchObject({
      name: "Test API",
      url: SPEC_URL,
      headerNames: [],
      operations: 3,
    });
    expect(project).not.toHaveProperty("organizationId");
    expect(mainSource(project)).not.toHaveProperty("headers");
    expect(mainSource(project)).not.toHaveProperty("body");
  });

  it("returns the existing project when the URL is already known", async () => {
    const cookie = await login();
    serveSpec();
    const first = await createProject(cookie);
    const again = await call("/api/projects", json("POST", { url: SPEC_URL }, cookie));
    expect(again.status).toBe(200);
    expect(((await again.json()) as ApiProject).id).toBe(first.id);
  });

  it("keeps project slugs unique", async () => {
    const cookie = await login();
    serveSpec();
    serveSpec(SPEC, {}, "https://staging.example.com/openapi.json");
    await createProject(cookie);
    const second = await createProject(cookie, { url: "https://staging.example.com/openapi.json" });
    expect(second.slug).toBe("test-2");
  });

  it("explains why a document was rejected", async () => {
    const cookie = await login();
    const attempt = async (url = SPEC_URL) => {
      const response = await call("/api/projects", json("POST", { url }, cookie));
      return { status: response.status, ...((await response.json()) as { code: string }) };
    };

    serveSpec({ hello: "world" });
    expect(await attempt()).toMatchObject({ status: 422, code: "invalid-spec" });

    serveSpec({ swagger: "2.0", info: {} });
    expect(await attempt()).toMatchObject({ status: 422, code: "invalid-spec" });

    serveSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/a": { get: { responses: { "200": { $ref: "./other.yaml#/R" } } } } },
    });
    expect(await attempt()).toMatchObject({ status: 422, code: "external-refs" });

    upstream("GET", SPEC_URL, () => new Response("nope", { status: 503 }));
    expect(await attempt()).toMatchObject({ status: 422, code: "http-error" });

    upstream(
      "GET",
      SPEC_URL,
      () => new Response("{}", { headers: { "content-length": "9000000" } }),
    );
    expect(await attempt()).toMatchObject({ status: 422, code: "too-large" });

    expect(await attempt("file:///etc/passwd")).toMatchObject({ status: 400, code: "bad-url" });
    expect(await attempt("https://nowhere.example/spec")).toMatchObject({
      status: 422,
      code: "unreachable",
    });
  });

  it("accepts documents well past the old 1.8 MB limit", async () => {
    const cookie = await login();
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 4000; i++) {
      schemas[`Schema${i}`] = {
        type: "object",
        description: `Generated schema number ${i}. ${crypto.randomUUID().repeat(12)}`,
        properties: { next: { $ref: `#/components/schemas/Schema${(i + 1) % 4000}` } },
      };
    }
    const big = {
      ...SPEC,
      paths: {
        "/big": {
          get: {
            tags: ["big"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Schema0" } },
                },
              },
            },
          },
        },
      },
      components: { schemas },
    };
    serveSpec(big);

    const project = await createProject(cookie);
    expect(project.bodyBytes).toBeGreaterThan(2_000_000);

    const variant = await createVariant(cookie, project.id, {
      selection: { mode: "include", operations: [], tags: ["big"] },
    });
    const served = await call(`${variant.path}.json`);
    expect(served.status).toBe(200);
    const doc = (await served.json()) as { components: { schemas: object } };
    expect(Object.keys(doc.components.schemas)).toHaveLength(4000);
  });
});

describe("sources that need credentials", () => {
  const PRIVATE_URL = "https://internal.example.com/openapi.json";
  const guarded = () =>
    upstream("GET", PRIVATE_URL, (request) =>
      request.headers.get("authorization") === "Bearer s3cret"
        ? new Response(JSON.stringify(SPEC))
        : new Response("unauthorized", { status: 401 }),
    );
  const auth = [{ name: "Authorization", value: "Bearer s3cret" }];

  it("sends the configured headers and never reveals their values", async () => {
    const cookie = await login();
    guarded();

    const denied = await call("/api/projects", json("POST", { url: PRIVATE_URL }, cookie));
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { detail: string }).detail).toMatch(/request header/);

    const response = await call(
      "/api/projects",
      json("POST", { url: PRIVATE_URL, headers: auth }, cookie),
    );
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain("s3cret");
    const project = JSON.parse(text) as ApiProject;
    expect(mainSource(project).headerNames).toEqual(["Authorization"]);

    // Encrypted at rest.
    const row = await sql("SELECT headers FROM sources WHERE project_id = ?", project.id);
    expect(JSON.stringify(row.results)).not.toContain("s3cret");

    // Used again on refresh.
    const refreshed = await call(`/api/projects/${project.id}/check`, {
      method: "POST",
      headers: { cookie },
    });
    expect(((await refreshed.json()) as { project: ApiProject }).project.lastStatus).toBe("ok");
  });

  it("keeps existing header values when the list is re-sent without them", async () => {
    const cookie = await login();
    guarded();
    const project = await createProject(cookie, { url: PRIVATE_URL, headers: auth });

    const kept = await patchSource(cookie, project, { headers: [{ name: "Authorization" }] });
    expect(kept.status).toBe(200);
    expect(((await kept.json()) as ApiProject).lastStatus).toBe("ok");

    // New headers are tried against the source before they replace the old ones.
    const wrong = await patchSource(cookie, project, {
      headers: [{ name: "Authorization", value: "Bearer wrong" }],
    });
    expect(wrong.status).toBe(422);
    const after = await call(`/api/projects/${project.id}/check`, {
      method: "POST",
      headers: { cookie },
    });
    expect(((await after.json()) as { project: ApiProject }).project.lastStatus).toBe("ok");
  });

  it("does not forward credentials when the source redirects to another origin", async () => {
    const cookie = await login();
    const elsewhere = "https://cdn.other.example/openapi.json";
    upstream(
      "GET",
      PRIVATE_URL,
      () => new Response(null, { status: 302, headers: { location: elsewhere } }),
    );
    upstream("GET", elsewhere, () => new Response(JSON.stringify(SPEC)));

    await createProject(cookie, { url: PRIVATE_URL, headers: auth });

    const first = upstreamCalls.find((c) => c.url === PRIVATE_URL);
    const second = upstreamCalls.find((c) => c.url === elsewhere);
    expect(first?.headers.get("authorization")).toBe("Bearer s3cret");
    expect(second?.headers.get("authorization")).toBeNull();
  });

  it("rejects malformed headers", async () => {
    const cookie = await login();
    for (const headers of [
      [{ name: "Bad Name", value: "x" }],
      [{ name: "Host", value: "x" }],
      [{ name: "X-Key", value: "line\nbreak" }],
      [{ name: "X-Key" }],
      "nope",
    ]) {
      const response = await call(
        "/api/projects",
        json("POST", { url: SPEC_URL, headers }, cookie),
      );
      expect(response.status).toBe(400);
    }
    expect(callsTo("GET", SPEC_URL)).toBe(0);
  });
});

describe("project settings", () => {
  it("renaming the slug moves the public URLs", async () => {
    const { cookie, project, variant } = await publish();
    expect(variant.path).toBe("/v/test/public");
    expect((await call("/v/test/public")).status).toBe(200);

    const patched = await call(
      `/api/projects/${project.id}`,
      json("PATCH", { slug: "pets-api", name: "Pets" }, cookie),
    );
    expect(patched.status).toBe(200);
    expect((await call("/v/test/public")).status).toBe(404);
    expect((await call("/v/pets-api/public")).status).toBe(200);

    const invalid = await call(
      `/api/projects/${project.id}`,
      json("PATCH", { slug: "Not Valid" }, cookie),
    );
    expect(invalid.status).toBe(400);
  });

  it("keeps a slug that was given up for the workspace that had it", async () => {
    const alice = await googleLogin("alice@example.com", "Alice");
    serveSpec();
    const project = await createProject(alice);
    await createVariant(alice, project.id, { slug: "public" });
    expect((await call("/v/test/public.json")).status).toBe(200);
    await call(`/api/projects/${project.id}`, json("PATCH", { slug: "acme-api" }, alice));

    // Someone else would like the address that builds out there still fetch.
    const mallory = await googleLogin("mallory@example.com", "Mallory");
    const theirs = "https://elsewhere.example.com/openapi.json";
    serveSpec({ ...SPEC, servers: [{ url: "https://collector.example.com" }] }, {}, theirs);
    const connected = await createProject(mallory, { url: theirs });
    // The document has the same title, so "test" is what it would have been called.
    expect(connected.slug).toBe("test-2");
    const check = await call("/api/projects/slug-check?slug=test", {
      headers: { cookie: mallory },
    });
    expect(await check.json()).toMatchObject({ available: false });
    const taken = await call(
      `/api/projects/${connected.id}`,
      json("PATCH", { slug: "test" }, mallory),
    );
    expect(taken.status).toBe(409);
    expect((await call("/v/test/public.json")).status).toBe(404);

    // The workspace that had it can have it back, and so can anyone once the hold is over.
    const back = await call(`/api/projects/${project.id}`, json("PATCH", { slug: "test" }, alice));
    expect(back.status).toBe(200);
    await call(`/api/projects/${project.id}?cascade=true`, {
      method: "DELETE",
      headers: { cookie: alice },
    });
    expect(
      (await call(`/api/projects/${connected.id}`, json("PATCH", { slug: "test" }, mallory)))
        .status,
    ).toBe(409);
    await sql("UPDATE released_slugs SET released_at = released_at - ?", 91 * 24 * 60 * 60 * 1000);
    expect(
      (await call(`/api/projects/${connected.id}`, json("PATCH", { slug: "test" }, mallory)))
        .status,
    ).toBe(200);
  });

  it("refuses a request that is far larger than anything it has a use for", async () => {
    const cookie = await login();
    const huge = await call(
      "/api/projects",
      json("POST", { url: SPEC_URL, padding: "x".repeat(1_200_000) }, cookie),
    );
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ code: "too-large" });
  });

  it("deleting a project with variants requires an explicit cascade", async () => {
    const { cookie, project, variant } = await publish();
    const refused = await call(`/api/projects/${project.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(refused.status).toBe(409);

    const deleted = await call(`/api/projects/${project.id}?cascade=true`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(200);
    expect((await call(variant.path)).status).toBe(404);
    const leftovers = await sql("SELECT count(*) AS n FROM variant_outputs");
    expect(leftovers.results[0]).toEqual({ n: 0 });
  });
});

describe("variants", () => {
  it("scopes slugs to their project", async () => {
    const cookie = await login();
    serveSpec();
    serveSpec(SPEC, {}, "https://other.example.com/openapi.json");
    const one = await createProject(cookie);
    const two = await createProject(cookie, { url: "https://other.example.com/openapi.json" });

    const a = await createVariant(cookie, one.id, { slug: "docs" });
    const b = await createVariant(cookie, two.id, { slug: "docs" });
    expect(a.path).toBe("/v/test/docs");
    expect(b.path).toBe("/v/test-2/docs");

    const duplicate = await call(
      "/api/variants",
      json(
        "POST",
        {
          projectId: one.id,
          name: "Again",
          slug: "docs",
          selection: { mode: "include", operations: [], tags: [] },
        },
        cookie,
      ),
    );
    expect(duplicate.status).toBe(409);

    const check = async (slug: string) =>
      (
        await call(`/api/variants/slug-check?projectId=${one.id}&slug=${slug}`, {
          headers: { cookie },
        })
      ).json();
    expect(await check("docs")).toMatchObject({ valid: true, available: false });
    expect(await check("sdk")).toMatchObject({ valid: true, available: true });
    expect(await check("-nope-")).toMatchObject({ valid: false });
  });

  it("validates input", async () => {
    const cookie = await login();
    serveSpec();
    const project = await createProject(cookie);
    const attempt = (body: object) => call("/api/variants", json("POST", body, cookie));
    const selection = { mode: "include", operations: [], tags: [] };

    expect((await attempt({ projectId: project.id, name: "", selection })).status).toBe(400);
    expect(
      (await attempt({ projectId: project.id, name: "x", selection: { mode: "all" } })).status,
    ).toBe(400);
    expect(
      (await attempt({ projectId: project.id, name: "x", slug: "A B", selection })).status,
    ).toBe(400);
    expect((await attempt({ projectId: "prj_missing", name: "x", selection })).status).toBe(404);

    // A name that cannot become a slug still works.
    const odd = await attempt({ projectId: project.id, name: "###", selection });
    expect(odd.status).toBe(201);
    expect(((await odd.json()) as { slug: string }).slug).toMatch(/^variant-[a-z0-9]{6}$/);
  });
});

describe("public URLs", () => {
  it("are built by the server, on the address the instance is known by", async () => {
    const { cookie, project, variant } = await publish();
    expect(variant.url).toBe(`https://proxy.test/v/${project.slug}/${variant.slug}`);

    const elsewhere = { APP_URL: "https://proxy.example.com/" };
    const [listed] = (await (
      await call("/api/variants", { headers: { cookie } }, elsewhere)
    ).json()) as Array<{ url: string }>;
    expect(listed?.url).toBe(`https://proxy.example.com/v/${project.slug}/${variant.slug}`);
    const shown = (await (
      await call(`/api/projects/${project.id}`, { headers: { cookie } }, elsewhere)
    ).json()) as { urlPrefix: string };
    expect(shown.urlPrefix).toBe("https://proxy.example.com/v/");
  });
});
