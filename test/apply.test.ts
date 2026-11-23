import { describe, expect, it } from "vitest";
import {
  applied,
  apply,
  call,
  callsTo,
  createProject,
  definitionOf,
  document,
  getProject,
  login,
  SPEC,
  SPEC_URL,
  serveSpec,
  upstream,
} from "./harness";

describe("applying a definition", () => {
  it("creates the project it describes, and serves its variants", async () => {
    const cookie = await login();
    serveSpec();
    const result = await applied(
      apply(cookie, definitionOf({ variants: { public: { include: { tags: ["pets"] } } } })),
    );
    expect(result).toMatchObject({
      dryRun: false,
      created: true,
      tookOver: false,
      project: { slug: "test", revision: 1, managedBy: "app" },
      sources: [
        { name: "main", action: "added", document: "fetched", follow: true, operations: 3 },
      ],
      variants: [
        {
          slug: "public",
          action: "created",
          url: "https://proxy.test/v/test/public",
          visibility: { value: "public", from: "workspace" },
          servedOperations: 2,
          totalOperations: 3,
        },
      ],
    });
    expect(callsTo("GET", SPEC_URL)).toBe(1);

    const served = await call("/v/test/public.json");
    expect(served.status).toBe(200);
    const body = (await served.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(body.paths)).toEqual(["/pets"]);

    const project = await getProject(cookie);
    expect(project.definition).toEqual(
      definitionOf({ variants: { public: { include: { tags: ["pets"] } } } }),
    );
    expect(project.state).toMatchObject({ revision: 1, managedBy: "app" });
  });

  it("takes an uploaded document for a source that is not followed", async () => {
    const cookie = await login();
    const definition = definitionOf({
      sources: [{ file: "./openapi.json" }],
      variants: { all: {} },
    });
    const refused = await apply(cookie, definition);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { code: string }).code).toBe("document-missing");

    const result = await applied(apply(cookie, definition, { documents: { main: document() } }));
    expect(result.sources).toMatchObject([{ document: "uploaded", follow: false }]);
    expect(callsTo("GET", SPEC_URL)).toBe(0);
    expect((await call("/v/test/all.json")).status).toBe(200);

    const project = await getProject(cookie);
    expect(project.state.check).toBeNull();
    expect(project.state.can.check).toBe(false);
  });

  it("changes nothing with a dry run, and answers what the apply would", async () => {
    const cookie = await login();
    serveSpec();
    const definition = definitionOf({ variants: { public: {} } });
    const rehearsal = await applied(apply(cookie, definition, { dryRun: true }));
    expect(rehearsal).toMatchObject({ dryRun: true, created: true });
    expect((await call("/api/projects/test", { headers: { cookie } })).status).toBe(404);

    const real = await applied(apply(cookie, definition));
    expect({ ...real, dryRun: true }).toEqual(rehearsal);
  });

  it("updates a project in place, keeping the ids of its variants", async () => {
    const cookie = await login();
    serveSpec();
    const before = await createProject(cookie, {
      variants: { public: { include: { tags: ["pets"] } }, internal: {} },
    });
    const result = await applied(
      apply(
        cookie,
        definitionOf({
          name: "Renamed",
          variants: { public: { include: { tags: ["pets", "internal"] } }, partners: {} },
        }),
        { ifRevision: before.state.revision },
      ),
    );
    expect(result.variants.map(({ slug, action }) => [slug, action])).toEqual([
      ["public", "changed"],
      ["partners", "created"],
      ["internal", "deleted"],
    ]);
    expect(result.sources).toMatchObject([{ action: "unchanged", document: "kept" }]);
    // The source was not fetched again: its copy is here and its address is the same.
    expect(callsTo("GET", SPEC_URL)).toBe(1);

    const after = await getProject(cookie);
    expect(after.state.variants.public?.id).toBe(before.state.variants.public?.id);
    expect(after.state.revision).toBe(2);
    expect(after.definition.name).toBe("Renamed");
    expect((await call("/v/test/internal.json")).status).toBe(404);
    expect((await call("/v/test/partners.json")).status).toBe(200);
  });

  it("never fails over a name the documents do not have: it says which, and serves the rest", async () => {
    const cookie = await login();
    // Deployed before the API it describes is live: two of these names do not exist yet.
    const result = await applied(
      apply(
        cookie,
        definitionOf({
          sources: [{ file: "openapi.json" }],
          variants: {
            public: {
              include: { tags: ["pets", "payments"], operations: ["GET /v2/pets"] },
              exclude: { operations: ["POST /pets", "DELETE /pets"] },
            },
          },
        }),
        { documents: { main: document() } },
      ),
    );
    expect(result.variants).toMatchObject([
      {
        slug: "public",
        servedOperations: 1,
        notFound: {
          include: { tags: ["payments"], operations: ["GET /v2/pets"] },
          exclude: { tags: [], operations: ["DELETE /pets"] },
        },
      },
    ]);
    expect((await call("/v/test/public.json")).status).toBe(200);

    // The API ships. The same file, deployed again with the new document, serves them.
    const shipped = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
    shipped.paths["/v2/pets"] = { get: { responses: { "200": { description: "ok" } } } };
    shipped.paths["/payments"] = {
      post: { tags: ["payments"], responses: { "201": { description: "paid" } } },
    };
    const project = await getProject(cookie);
    const later = await applied(
      apply(cookie, project.definition, { documents: { main: document(shipped) } }),
    );
    expect(later.variants[0]).toMatchObject({
      action: "unchanged",
      servedOperations: 3,
      notFound: { include: { tags: [], operations: [] } },
    });
  });

  it("warns about what is probably not meant, and applies it anyway", async () => {
    const cookie = await login();
    const result = await applied(
      apply(
        cookie,
        definitionOf({ sources: [{ file: "openapi.json" }], variants: { empty: { include: {} } } }),
        { documents: { main: document() } },
      ),
    );
    expect(result.warnings).toMatchObject([{ path: "variants.empty.include" }]);
    expect(result.variants).toMatchObject([{ slug: "empty", servedOperations: 0 }]);
    const served = await call("/v/test/empty.json");
    expect(served.status).toBe(200);
    expect(((await served.json()) as { paths?: object }).paths ?? {}).toEqual({});
  });

  it("can be told what it starts from: nothing, or a revision", async () => {
    const cookie = await login();
    serveSpec();
    const definition = definitionOf({ variants: { public: {}, internal: {} } });
    // "Only if there is no such project", as a form that makes one says.
    expect((await apply(cookie, definition, { ifRevision: 0 })).status).toBe(201);
    const again = await apply(cookie, definitionOf(), { ifRevision: 0 });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      code: "conflict",
      error: 'There is a project "test" already.',
    });
    // It did not write over what was there.
    expect(Object.keys((await getProject(cookie)).definition.variants)).toEqual([
      "public",
      "internal",
    ]);

    // A project that was deleted is not made again by a save that started from it.
    await call("/api/projects/test", { method: "DELETE", headers: { cookie } });
    const gone = await apply(cookie, definition, { ifRevision: 1 });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ error: "This project no longer exists." });
    expect((await call("/api/projects/test", { headers: { cookie } })).status).toBe(404);
    // A deploy says nothing about where it starts from: the file is what holds.
    expect((await apply(cookie, definition)).status).toBe(201);
    expect((await apply(cookie, definitionOf())).status).toBe(200);
    expect((await getProject(cookie)).definition.variants).toEqual({});
  });

  it("says what is wrong with a document that is not one", async () => {
    const cookie = await login();
    const definition = definitionOf({ sources: [{ file: "openapi.json" }] });
    for (const entry of ["text", null, 7, [], {}, { content: 7 }]) {
      const response = await apply(cookie, definition, { documents: { main: entry as never } });
      expect(response.status, JSON.stringify(entry)).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("documents.main");
    }
  });

  it("treats a variant's slug as a name like any other", async () => {
    const cookie = await login();
    const definition = definitionOf({
      sources: [{ file: "openapi.json" }],
      variants: { constructor: {}, public: {} },
    });
    await applied(apply(cookie, definition, { documents: { main: document() } }));
    expect((await call("/v/test/constructor.json")).status).toBe(200);
    const result = await applied(apply(cookie, { ...definition, variants: { public: {} } }));
    expect(result.variants.map(({ slug, action }) => [slug, action])).toEqual([
      ["public", "unchanged"],
      ["constructor", "deleted"],
    ]);
    expect((await call("/v/test/constructor.json")).status).toBe(404);
  });

  it("lets a source be called anything too, and keeps its credentials apart", async () => {
    const cookie = await login();
    const billing = "https://billing.example.com/openapi.json";
    upstream("GET", billing, (request) =>
      request.headers.get("x-key") === "k"
        ? Response.json({
            openapi: "3.1.0",
            info: { title: "Billing", version: "1" },
            paths: { "/invoices": { get: { responses: { "200": { description: "ok" } } } } },
          })
        : new Response("no", { status: 401 }),
    );
    serveSpec();
    const result = await applied(
      apply(
        cookie,
        definitionOf({
          sources: [
            { name: "constructor", url: SPEC_URL, follow: true, main: true },
            { name: "billing", url: billing, follow: true },
          ],
        }),
        { credentials: { billing: [{ name: "X-Key", value: "k" }] } },
      ),
    );
    expect(result.sources.map(({ name, document }) => [name, document])).toEqual([
      ["constructor", "fetched"],
      ["billing", "fetched"],
    ]);
    expect((await getProject(cookie)).state.sources.map((source) => source.headerNames)).toEqual([
      [],
      ["X-Key"],
    ]);
  });

  it("clears the error of a source that an apply takes out or reads from somewhere else", async () => {
    const cookie = await login();
    const billing = "https://billing.example.com/openapi.json";
    serveSpec();
    serveSpec(
      {
        openapi: "3.1.0",
        info: { title: "Billing", version: "1" },
        paths: { "/invoices": { get: { responses: { "200": { description: "ok" } } } } },
      },
      {},
      billing,
    );
    const definition = definitionOf({
      sources: [
        { name: "core", url: SPEC_URL, follow: true, main: true },
        { name: "billing", url: billing, follow: true },
      ],
      variants: { all: {} },
    });
    await applied(apply(cookie, definition));
    upstream("GET", billing, () => new Response("gone", { status: 500 }));
    await call("/api/projects/test/check", { method: "POST", headers: { cookie } });
    expect((await getProject(cookie)).state.check).toMatchObject({ lastStatus: "error" });
    expect((await call("/v/test/all.json")).headers.get("x-proxy-source-status")).toBe(
      "stale-error",
    );

    // Changing something else leaves the error where it is: the source is still failing.
    await applied(apply(cookie, { ...definition, name: "Renamed" }));
    expect((await getProject(cookie)).state.check).toMatchObject({ lastStatus: "error" });
    // Taking the failing source out mends the project, at once.
    await applied(apply(cookie, { ...definition, sources: [{ url: SPEC_URL, follow: true }] }));
    expect((await getProject(cookie)).state.check).toMatchObject({
      lastStatus: "ok",
      lastError: null,
    });
    expect((await call("/v/test/all.json")).headers.get("x-proxy-source-status")).toBe("fresh");
  });

  it("refuses a variant that names more than can be kept for one", async () => {
    const cookie = await login();
    const operations = Array.from({ length: 9_000 }, (_, n) => `GET /${"x".repeat(150)}/${n}`);
    const response = await apply(
      cookie,
      definitionOf({
        sources: [{ file: "openapi.json" }],
        variants: { huge: { include: { operations } } },
      }),
      { documents: { main: document() } },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid-definition",
      problems: [{ path: "variants.huge" }],
    });

    // What is kept is counted in bytes: fewer characters can be more of them.
    const wide = Array.from({ length: 300 }, (_, n) => `GET /${"字".repeat(1_500)}/${n}`);
    const second = await apply(
      cookie,
      definitionOf({
        sources: [{ file: "openapi.json" }],
        variants: { wide: { include: { operations: wide } } },
      }),
      { documents: { main: document() } },
    );
    expect(second.status).toBe(400);
  });

  it("takes away a hundred variants in one go", async () => {
    const cookie = await login();
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, n) => [`variant-${n}`, { include: { tags: ["pets"] } }]),
    );
    const definition = definitionOf({ sources: [{ file: "openapi.json" }], variants: many });
    await applied(apply(cookie, definition, { documents: { main: document() } }));
    expect((await call("/v/test/variant-99.json")).status).toBe(200);

    const result = await applied(apply(cookie, { ...definition, variants: { only: {} } }));
    expect(result.variants.filter((variant) => variant.action === "deleted")).toHaveLength(100);
    expect(Object.keys((await getProject(cookie)).definition.variants)).toEqual(["only"]);
    expect((await call("/v/test/variant-99.json")).status).toBe(404);
  });

  it("stops reading uploaded documents once they are more than a project may hold", async () => {
    const cookie = await login();
    // Twelve megabytes of nothing, in a few kilobytes.
    const stream = new Blob([new Uint8Array(12_000_000)])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(20_000);
    const refused = await apply(cookie, definitionOf({ sources: [{ file: "bomb.json" }] }), {
      documents: { main: { gzip: btoa(String.fromCharCode(...bytes)) } },
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "too-large", source: "main" });

    // And of several, the sum is what counts.
    const big = JSON.stringify({ ...SPEC, "x-padding": "x".repeat(2_600_000) });
    const together = await apply(
      cookie,
      definitionOf({
        sources: [
          { name: "a", file: "a.json", main: true },
          { name: "b", file: "b.json", pathPrefix: "/b" },
        ],
      }),
      { documents: { a: { content: big }, b: { content: big } } },
    );
    expect(together.status).toBe(422);
    expect(await together.json()).toMatchObject({ code: "too-large", source: "b" });
  });

  it("keeps a document that was uploaded for a file until another is", async () => {
    const cookie = await login();
    const definition = definitionOf({ sources: [{ file: "a.json" }], variants: { all: {} } });
    await applied(apply(cookie, definition, { documents: { main: document() } }));

    // The definition changes and brings no document: the copy that is here stays.
    const moved = await applied(
      apply(cookie, { ...definition, sources: [{ file: "elsewhere/b.json", pathPrefix: "/v1" }] }),
    );
    expect(moved.sources).toMatchObject([{ action: "updated", document: "kept" }]);
    expect(moved.operations.added).toContain("GET /v1/pets");

    // From a file to an address nobody uploaded from and nobody follows: there is no document for it.
    const lost = await apply(cookie, { ...definition, sources: [{ url: SPEC_URL }] });
    expect(lost.status).toBe(422);
    expect(await lost.json()).toMatchObject({ code: "document-missing", source: "main" });
    expect(callsTo("GET", SPEC_URL)).toBe(0);
  });
});
