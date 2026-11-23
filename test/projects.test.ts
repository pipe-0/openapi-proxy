import { describe, expect, it } from "vitest";
import {
  type ApiProject,
  applied,
  apply,
  call,
  callsTo,
  createProject,
  createVariant,
  definitionOf,
  document,
  edit,
  getProject,
  googleLogin,
  json,
  login,
  publish,
  SPEC,
  SPEC_URL,
  serveSpec,
  sql,
  upstream,
  upstreamCalls,
} from "./harness";

describe("creating a project", () => {
  it("fetches the document of a followed source and indexes its operations", async () => {
    const cookie = await login();
    serveSpec();
    const project = await createProject(cookie);

    expect(project.definition).toEqual(definitionOf());
    expect(project.state.operations.map((op) => op.key).sort()).toEqual([
      "GET /pets",
      "POST /internal/flush",
      "POST /pets",
    ]);
    expect(project.state.sources).toHaveLength(1);
    expect(project.state.sources[0]).toMatchObject({
      name: "main",
      title: "Test API",
      headerNames: [],
      operations: 3,
    });
    expect(project.state).not.toHaveProperty("organizationId");
    expect(project.state.sources[0]).not.toHaveProperty("headers");
    expect(project.state.sources[0]).not.toHaveProperty("body");
  });

  it("is listed with every other project of the workspace, in the same shape", async () => {
    const cookie = await login();
    serveSpec();
    const one = await createProject(cookie, { variants: { public: {} } });
    const two = await createProject(cookie, { project: "second", name: "Second" });
    const listed = (await (
      await call("/api/projects", { headers: { cookie } })
    ).json()) as ApiProject[];
    expect(listed).toEqual([one, two]);
  });

  it("gives the slug of another workspace's project to no one else", async () => {
    const alice = await googleLogin("alice@example.com", "Alice");
    serveSpec();
    await createProject(alice);

    const mallory = await googleLogin("mallory@example.com", "Mallory");
    const taken = await apply(mallory, definitionOf());
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "slug-taken" });
    // And nothing about it can be read or changed from there.
    expect((await call("/api/projects/test", { headers: { cookie: mallory } })).status).toBe(404);
    expect(
      (await call("/api/projects/test", { method: "DELETE", headers: { cookie: mallory } })).status,
    ).toBe(404);
    const check = await call("/api/slugs/test", { headers: { cookie: mallory } });
    expect(await check.json()).toMatchObject({ valid: true, available: false });
  });

  it("explains why a document was rejected, and names its source", async () => {
    const cookie = await login();
    const attempt = async (url = SPEC_URL) => {
      const response = await apply(cookie, definitionOf({ sources: [{ url, follow: true }] }));
      return {
        status: response.status,
        ...((await response.json()) as { code: string; source?: string }),
      };
    };

    serveSpec({ hello: "world" });
    expect(await attempt()).toMatchObject({ status: 422, code: "invalid-spec", source: "main" });

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

    expect(await attempt("file:///etc/passwd")).toMatchObject({
      status: 400,
      code: "invalid-definition",
    });
    expect(await attempt("https://nowhere.example/spec")).toMatchObject({
      status: 422,
      code: "unreachable",
    });
    // Nothing of any of these was kept.
    expect((await call("/api/projects/test", { headers: { cookie } })).status).toBe(404);
  });

  it("explains why an uploaded document was rejected", async () => {
    const cookie = await login();
    const definition = definitionOf({ sources: [{ file: "openapi.json" }] });
    const invalid = await apply(cookie, definition, {
      documents: { main: document({ hello: "world" }) },
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: "invalid-spec", source: "main" });

    const stranger = await apply(cookie, definition, {
      documents: { main: document(), other: document() },
    });
    expect(stranger.status).toBe(400);
    expect(((await stranger.json()) as { error: string }).error).toMatch(/no source of that name/);

    const garbage = await apply(cookie, definition, { documents: { main: { gzip: "not gzip" } } });
    expect(garbage.status).toBe(400);
  });

  it("accepts documents well past 2 MB, fetched or uploaded compressed", async () => {
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
    expect(project.state.bodyBytes).toBeGreaterThan(2_000_000);

    const variant = await createVariant(cookie, project, "big", { include: { tags: ["big"] } });
    const served = await call(`${variant.path}.json`);
    expect(served.status).toBe(200);
    const doc = (await served.json()) as { components: { schemas: object } };
    expect(Object.keys(doc.components.schemas)).toHaveLength(4000);

    // The same document, the way a deploy sends it.
    const stream = new Blob([JSON.stringify(big)])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const uploaded = await applied(
      apply(
        cookie,
        definitionOf({
          project: "uploaded",
          sources: [{ file: "big.json" }],
          variants: { big: {} },
        }),
        { documents: { main: { gzip: btoa(binary) } } },
      ),
    );
    expect(uploaded.sources).toMatchObject([{ document: "uploaded" }]);
    expect(uploaded.sources[0]?.bytes).toBe(project.state.bodyBytes);
    expect((await call("/v/uploaded/big.json")).status).toBe(200);
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
  const definition = definitionOf({ sources: [{ url: PRIVATE_URL, follow: true }] });
  const setCredentials = (cookie: string, headers: unknown, source = "main") =>
    call("/api/projects/test/credentials", json("PUT", { source, headers }, cookie));
  const check = async (cookie: string) =>
    (await (
      await call("/api/projects/test/check", { method: "POST", headers: { cookie } })
    ).json()) as { lastStatus: string };

  it("sends the configured headers and never reveals their values", async () => {
    const cookie = await login();
    guarded();

    const denied = await apply(cookie, definition);
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { detail: string }).detail).toMatch(/request header/);

    const response = await apply(cookie, definition, { credentials: { main: auth } });
    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain("s3cret");
    const read = await call("/api/projects/test", { headers: { cookie } });
    const text = await read.text();
    expect(text).not.toContain("s3cret");
    const project = JSON.parse(text) as ApiProject;
    expect(project.state.sources[0]?.headerNames).toEqual(["Authorization"]);
    // They are not part of the definition.
    expect(JSON.stringify(project.definition)).not.toContain("Authorization");

    // Encrypted at rest.
    const row = await sql("SELECT headers FROM sources");
    expect(JSON.stringify(row.results)).not.toContain("s3cret");

    // Used again when the source is checked.
    expect((await check(cookie)).lastStatus).toBe("ok");
  });

  it("keeps existing header values when the list is re-sent without them", async () => {
    const cookie = await login();
    guarded();
    await applied(apply(cookie, definition, { credentials: { main: auth } }));

    const kept = await setCredentials(cookie, [{ name: "Authorization" }]);
    expect(kept.status).toBe(200);
    expect((await check(cookie)).lastStatus).toBe("ok");

    // New headers are tried against the source before they replace the old ones.
    const wrong = await setCredentials(cookie, [{ name: "Authorization", value: "Bearer wrong" }]);
    expect(wrong.status).toBe(422);
    expect((await check(cookie)).lastStatus).toBe("ok");

    expect((await setCredentials(cookie, auth, "nope")).status).toBe(404);
  });

  it("keeps them across saves, and drops them when the address moves to another host", async () => {
    const cookie = await login();
    guarded();
    await applied(apply(cookie, definition, { credentials: { main: auth } }));

    await applied(edit(cookie, "test", (d) => ({ ...d, name: "Renamed" })));
    expect((await getProject(cookie)).state.sources[0]?.headerNames).toEqual(["Authorization"]);

    // Another path on the same host: still theirs to receive.
    const moved = "https://internal.example.com/v2/openapi.json";
    upstream("GET", moved, (request) =>
      request.headers.get("authorization") === "Bearer s3cret"
        ? new Response(JSON.stringify(SPEC))
        : new Response("unauthorized", { status: 401 }),
    );
    await applied(edit(cookie, "test", (d) => ({ ...d, sources: [{ url: moved, follow: true }] })));
    expect((await getProject(cookie)).state.sources[0]?.headerNames).toEqual(["Authorization"]);

    // Another host: they were not entered for it, and are not sent there.
    const elsewhere = "https://elsewhere.example.com/openapi.json";
    serveSpec(SPEC, {}, elsewhere);
    await applied(
      edit(cookie, "test", (d) => ({ ...d, sources: [{ url: elsewhere, follow: true }] })),
    );
    expect((await getProject(cookie)).state.sources[0]?.headerNames).toEqual([]);
    const sent = upstreamCalls.find((c) => c.url === elsewhere);
    expect(sent?.headers.get("authorization")).toBeNull();
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

    await applied(apply(cookie, definition, { credentials: { main: auth } }));

    const first = upstreamCalls.find((c) => c.url === PRIVATE_URL);
    const second = upstreamCalls.find((c) => c.url === elsewhere);
    expect(first?.headers.get("authorization")).toBe("Bearer s3cret");
    expect(second?.headers.get("authorization")).toBeNull();
  });

  it("rejects malformed headers, and credentials for a source that is not followed", async () => {
    const cookie = await login();
    for (const headers of [
      [{ name: "Bad Name", value: "x" }],
      [{ name: "Host", value: "x" }],
      [{ name: "X-Key", value: "line\nbreak" }],
      [{ name: "X-Key" }],
      "nope",
    ]) {
      const response = await apply(cookie, definitionOf(), {
        credentials: { main: headers as never },
      });
      expect(response.status).toBe(400);
    }
    expect(callsTo("GET", SPEC_URL)).toBe(0);

    const uploaded = await apply(cookie, definitionOf({ sources: [{ file: "openapi.json" }] }), {
      documents: { main: document() },
      credentials: { main: [{ name: "X-Key", value: "x" }] },
    });
    expect(uploaded.status).toBe(400);
    expect(((await uploaded.json()) as { error: string }).error).toMatch(/followed/);
  });
});

describe("a project's slug", () => {
  it("stays with the workspace that gave it up, for a while", async () => {
    const alice = await googleLogin("alice@example.com", "Alice");
    serveSpec();
    await createProject(alice, { variants: { public: {} } });
    expect((await call("/v/test/public.json")).status).toBe(200);
    const deleted = await call("/api/projects/test", {
      method: "DELETE",
      headers: { cookie: alice },
    });
    expect(deleted.status).toBe(200);
    expect((await call("/v/test/public.json")).status).toBe(404);

    // Someone else would like the address that builds out there still fetch.
    const mallory = await googleLogin("mallory@example.com", "Mallory");
    const theirs = definitionOf({
      sources: [{ url: "https://elsewhere.example.com/openapi.json", follow: true }],
      variants: { public: {} },
    });
    serveSpec(
      { ...SPEC, servers: [{ url: "https://collector.example.com" }] },
      {},
      "https://elsewhere.example.com/openapi.json",
    );
    const check = await call("/api/slugs/test", { headers: { cookie: mallory } });
    expect(await check.json()).toMatchObject({ available: false });
    const taken = await apply(mallory, theirs);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "slug-taken" });
    expect((await call("/v/test/public.json")).status).toBe(404);

    // The workspace that had it can have it back, and so can anyone once the hold is over.
    const free = await call("/api/slugs/test", { headers: { cookie: alice } });
    expect(await free.json()).toMatchObject({ available: true });
    await createProject(alice);
    await call("/api/projects/test", { method: "DELETE", headers: { cookie: alice } });
    expect((await apply(mallory, theirs)).status).toBe(409);
    await sql("UPDATE released_slugs SET released_at = released_at - ?", 91 * 24 * 60 * 60 * 1000);
    expect((await apply(mallory, theirs)).status).toBe(201);
  });

  it("is what the request is addressed to, and what the definition says", async () => {
    const cookie = await login();
    const response = await call(
      "/api/projects/other",
      json("PUT", { definition: definitionOf() }, cookie),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/"test".*"other"/);

    const check = async (slug: string) =>
      (await call(`/api/slugs/${slug}`, { headers: { cookie } })).json();
    expect(await check("sdk")).toMatchObject({ valid: true, available: true });
    expect(await check("-nope-")).toMatchObject({ valid: false });
    serveSpec();
    await createProject(cookie);
    // Its own project has the slug already: not free for a new one.
    expect(await check("test")).toMatchObject({ valid: true, available: false });
  });
});

describe("requests", () => {
  it("are refused when they are far larger than they have a use for", async () => {
    const cookie = await login();
    const huge = await call(
      "/api/workspace/keys",
      json("POST", { name: "x", padding: "x".repeat(1_200_000) }, cookie),
    );
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ code: "too-large" });

    // A definition comes with documents, so it may be larger, up to a point.
    serveSpec();
    const roomy = await apply(cookie, { ...definitionOf(), padding: "x".repeat(1_200_000) });
    expect(roomy.status).toBe(400);
    const tooMuch = await apply(cookie, { ...definitionOf(), padding: "x".repeat(8_200_000) });
    expect(tooMuch.status).toBe(413);
  });

  it("say what is wrong with a definition, by path", async () => {
    const cookie = await login();
    const response = await apply(cookie, {
      version: 1,
      project: "test",
      sources: [{ url: SPEC_URL, follow: true, folow: true }],
      variants: { "A B": {}, ok: { include: { tags: "pets" }, mode: "all" } },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      problems: Array<{ path: string; message: string }>;
    };
    expect(body.code).toBe("invalid-definition");
    expect(body.problems.map((problem) => problem.path).sort()).toEqual([
      "sources[0].folow",
      "variants.A B",
      "variants.ok.include.tags",
      "variants.ok.mode",
    ]);

    const future = await apply(cookie, { ...definitionOf(), version: 2 });
    expect(future.status).toBe(400);
    expect(await future.json()).toMatchObject({ code: "unsupported-version" });
    expect(callsTo("GET", SPEC_URL)).toBe(0);
  });
});

describe("deleting a project", () => {
  it("takes its variants and what was rendered for them along", async () => {
    const { cookie, variant } = await publish();
    expect((await call(`${variant.path}.json`)).status).toBe(200);
    const stored = await sql("SELECT count(*) AS n FROM variant_outputs");
    expect(stored.results[0]).toEqual({ n: 1 });

    const deleted = await call("/api/projects/test", { method: "DELETE", headers: { cookie } });
    expect(deleted.status).toBe(200);
    expect((await call(variant.path)).status).toBe(404);
    const leftovers = await sql("SELECT count(*) AS n FROM variant_outputs");
    expect(leftovers.results[0]).toEqual({ n: 0 });
    for (const table of ["sources", "variants"]) {
      expect((await sql(`SELECT count(*) AS n FROM ${table}`)).results[0]).toEqual({ n: 0 });
    }
  });
});

describe("variants", () => {
  it("have slugs that are theirs within their project only", async () => {
    const cookie = await login();
    serveSpec();
    const one = await createProject(cookie);
    const two = await createProject(cookie, { project: "test-2" });

    const a = await createVariant(cookie, one, "docs");
    const b = await createVariant(cookie, two, "docs");
    expect(a.path).toBe("/v/test/docs");
    expect(b.path).toBe("/v/test-2/docs");
    expect(a.id).not.toBe(b.id);
    expect((await call("/v/test/docs.json")).status).toBe(200);
    expect((await call("/v/test-2/docs.json")).status).toBe(200);
  });
});

describe("public URLs", () => {
  it("are built by the server, on the address the instance is known by", async () => {
    const { cookie, variant } = await publish();
    expect(variant.url).toBe("https://proxy.test/v/test/public");

    const elsewhere = { APP_URL: "https://proxy.example.com/" };
    const shown = (await (
      await call("/api/projects/test", { headers: { cookie } }, elsewhere)
    ).json()) as ApiProject;
    expect(shown.state.urlPrefix).toBe("https://proxy.example.com/v/");
    expect(shown.state.variants.public?.url).toBe("https://proxy.example.com/v/test/public");
  });
});
