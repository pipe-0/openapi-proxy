import type { ProjectDefinition, VariantDefinition } from "@openapi-proxy/core";
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
  login,
  MAIL,
  mailbox,
  runTimer,
  SPEC,
  SPEC_URL,
  serveSpec,
  sql,
  textOf,
  upstream,
} from "./harness";

const BILLING_URL = "https://billing.example.com/openapi.json";
const ok = { "200": { description: "ok" } };

/** A second service. Its `Pet` means something else, and it also defines GET /pets. */
const BILLING = {
  openapi: "3.1.0",
  info: { title: "Billing API", version: "9" },
  servers: [{ url: "https://billing.internal" }],
  paths: {
    "/invoices": {
      get: {
        tags: ["billing"],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
    },
    "/pets": { get: { tags: ["billing"], responses: ok } },
  },
  components: {
    schemas: { Pet: { type: "object", properties: { invoiceId: { type: "string" } } } },
  },
};

type Doc = {
  openapi: string;
  info: { title: string };
  servers?: unknown;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

const CORE = { name: "core", url: SPEC_URL, main: true, follow: true };
const BILLING_SOURCE = { name: "billing", url: BILLING_URL, follow: true };
const keys = (p: ApiProject) => p.state.operations.map((op) => op.key);
const sourcesOf = (cookie: string, sources: ProjectDefinition["sources"]) =>
  edit(cookie, "test", (definition) => ({ ...definition, sources }));

const variant = (cookie: string, more: VariantDefinition = {}, slug = "everything") =>
  createVariant(cookie, "test", slug, { name: "Everything", ...more });
const served = async (path: string) => (await (await call(`${path}.json`)).json()) as Doc;

/** Core and Billing, merged, with Billing added after the project existed. */
async function merged(cookie?: string) {
  const session = cookie ?? (await login());
  serveSpec();
  serveSpec(BILLING, {}, BILLING_URL);
  await createProject(session);
  const result = await applied(sourcesOf(session, [CORE, BILLING_SOURCE]));
  expect(result.sources).toMatchObject([
    // The one that was there got a name, and is still the same source.
    { name: "core", action: "updated", document: "kept" },
    { name: "billing", action: "added", document: "fetched" },
  ]);
  return { cookie: session, project: await getProject(session) };
}

describe("merging several documents into one project", () => {
  it("adds a document to an existing project: its operations join, and each knows where it came from", async () => {
    const { project: p } = await merged();
    expect(p.state.sources.map((source) => [source.name, source.title, source.operations])).toEqual(
      [
        ["core", "Test API", 3],
        ["billing", "Billing API", 2],
      ],
    );
    expect(keys(p)).toEqual(["GET /pets", "POST /pets", "POST /internal/flush", "GET /invoices"]);
    expect(Object.fromEntries(p.state.operations.map((op) => [op.key, op.source]))).toEqual({
      "GET /pets": "core",
      "POST /pets": "core",
      "POST /internal/flush": "core",
      "GET /invoices": "billing",
    });
    // One fetch each: the document that was there was not fetched for the merge.
    expect(callsTo("GET", SPEC_URL)).toBe(1);
    expect(callsTo("GET", BILLING_URL)).toBe(1);
  });

  it("says what merging did: an operation left out, a component renamed, servers not carried over", async () => {
    const { project: p } = await merged();
    expect(p.state.notes).toEqual(
      expect.arrayContaining([
        {
          kind: "operation-left-out",
          source: "billing",
          operation: "GET /pets",
          keptFrom: "core",
        },
        {
          kind: "component-renamed",
          source: "billing",
          group: "schemas",
          from: "Pet",
          to: "BillingPet",
        },
        { kind: "servers-differ", source: "billing" },
      ]),
    );
  });

  it("serves the merged document: the main one's top level, every operation with the schema it had", async () => {
    const { cookie } = await merged();
    const everything = await variant(cookie);
    const doc = await served(everything.path);

    expect(doc.info.title).toBe("Test API");
    expect(JSON.stringify(doc)).not.toContain("billing.internal");
    expect(Object.keys(doc.paths)).toEqual(["/pets", "/internal/flush", "/invoices"]);
    expect(JSON.stringify(doc.paths["/invoices"])).toContain("#/components/schemas/BillingPet");
    expect(JSON.stringify(doc.paths["/pets"])).toContain('#/components/schemas/Pet"');
    expect(doc.components?.schemas).toHaveProperty("BillingPet.properties.invoiceId");
    expect(doc.components?.schemas).toHaveProperty("Pet.properties.name");

    // A variant of only the second service carries only what that needs.
    const billing = await variant(cookie, { include: { tags: ["billing"] } }, "billing");
    const only = await served(billing.path);
    expect(Object.keys(only.paths)).toEqual(["/invoices"]);
    expect(Object.keys(only.components?.schemas ?? {})).toEqual(["BillingPet"]);
  });

  it("can be created from several documents at once; the main one leads, wherever it is listed", async () => {
    const cookie = await login();
    serveSpec();
    serveSpec(BILLING, {}, BILLING_URL);
    const p = await createProject(cookie, {
      sources: [
        { name: "core", url: SPEC_URL, follow: true, pathPrefix: "/core" },
        { name: "billing", url: BILLING_URL, follow: true, main: true },
      ],
    });
    // Listed as the definition lists them.
    expect(p.state.sources.map((source) => source.name)).toEqual(["core", "billing"]);
    expect(p.definition.sources.map((source) => [source.name, source.pathPrefix])).toEqual([
      ["core", "/core"],
      ["billing", undefined],
    ]);
    // Merged with the main one first.
    expect(keys(p)).toEqual([
      "GET /invoices",
      "GET /pets",
      "GET /core/pets",
      "POST /core/pets",
      "POST /core/internal/flush",
    ]);
    const everything = await variant(cookie);
    expect((await served(everything.path)).info.title).toBe("Billing API");
  });

  it("mounts a document under a path prefix, and lets the main document be chosen", async () => {
    const { cookie } = await merged();

    const prefixed = await applied(
      sourcesOf(cookie, [CORE, { ...BILLING_SOURCE, name: "money", pathPrefix: "billing" }]),
    );
    // Renamed and moved, and still the same source with the same document.
    expect(prefixed.sources).toMatchObject([
      { name: "core", action: "unchanged" },
      { name: "money", action: "updated", document: "kept" },
    ]);
    expect(prefixed.operations.added).toEqual(["GET /billing/invoices", "GET /billing/pets"]);
    expect(prefixed.operations.removed).toEqual(["GET /invoices"]);
    const afterPrefix = await getProject(cookie);
    expect(afterPrefix.definition.sources[1]?.pathPrefix).toBe("/billing");
    expect(keys(afterPrefix)).toEqual([
      "GET /pets",
      "POST /pets",
      "POST /internal/flush",
      "GET /billing/invoices",
      "GET /billing/pets",
    ]);
    // The component is named after the document's new name.
    expect(afterPrefix.state.notes).toContainEqual(
      expect.objectContaining({ kind: "component-renamed", to: "MoneyPet" }),
    );

    const { main: _, ...core } = CORE;
    await applied(
      sourcesOf(cookie, [
        core,
        { ...BILLING_SOURCE, name: "money", pathPrefix: "/billing", main: true },
      ]),
    );
    const everything = await variant(cookie);
    expect((await served(everything.path)).info.title).toBe("Billing API");
    expect(callsTo("GET", SPEC_URL)).toBe(1);
    expect(callsTo("GET", BILLING_URL)).toBe(1);
  });

  it("takes a document out again; what a variant selected from it comes back if it does", async () => {
    const { cookie } = await merged();
    const picked = await variant(cookie, {
      include: { operations: ["GET /invoices", "GET /pets"] },
    });
    expect(Object.keys((await served(picked.path)).paths)).toEqual(["/pets", "/invoices"]);

    const removed = await applied(sourcesOf(cookie, [{ url: SPEC_URL, follow: true }]));
    expect(removed.sources.map((source) => [source.name, source.action])).toEqual([
      ["main", "updated"],
      ["billing", "removed"],
    ]);
    // The name that is no longer there is reported, and stops nothing.
    expect(removed.variants[0]?.notFound.include.operations).toEqual(["GET /invoices"]);
    const after = await getProject(cookie);
    expect(after.state.sources).toHaveLength(1);
    expect(after.state.notes).toEqual([]);
    expect(Object.keys((await served(picked.path)).paths)).toEqual(["/pets"]);

    // A project has at least one document.
    const none = await sourcesOf(cookie, []);
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ code: "invalid-definition" });

    await applied(sourcesOf(cookie, [CORE, BILLING_SOURCE]));
    expect(Object.keys((await served(picked.path)).paths)).toEqual(["/pets", "/invoices"]);
  });

  it("refuses a document that cannot be fetched or is listed twice, and leaves the project as it was", async () => {
    const { cookie } = await merged();
    const twice = await sourcesOf(cookie, [
      CORE,
      BILLING_SOURCE,
      { name: "again", url: BILLING_URL },
    ]);
    expect(twice.status).toBe(400);

    upstream(
      "GET",
      "https://down.example.com/openapi.json",
      () => new Response("no", { status: 500 }),
    );
    const failed = await sourcesOf(cookie, [
      CORE,
      BILLING_SOURCE,
      { name: "down", url: "https://down.example.com/openapi.json", follow: true },
    ]);
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ code: "http-error", source: "down" });
    const after = await getProject(cookie);
    expect(after.state.sources).toHaveLength(2);
    expect(after.state.revision).toBe(2);
  });

  it("merges a document the service follows with one that was uploaded, and only checks the first", async () => {
    const cookie = await login();
    serveSpec();
    await createProject(
      cookie,
      {
        sources: [
          CORE,
          { name: "billing", file: "./billing/openapi.json", pathPrefix: "/billing" },
        ],
        variants: { everything: {} },
      },
      { documents: { billing: document(BILLING) } },
    );
    const p = await getProject(cookie);
    expect(keys(p)).toContain("GET /billing/invoices");
    expect(p.state.check).not.toBeNull();

    const next = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
    next.paths["/owners"] = { get: { tags: ["pets"], responses: ok } };
    serveSpec(next);
    await sql("UPDATE projects SET next_check_at = ?", Date.now() - 1);
    await runTimer();

    const after = await getProject(cookie);
    expect(keys(after)).toContain("GET /owners");
    // The uploaded one is still what was uploaded, and nobody asked for it anywhere.
    expect(keys(after)).toContain("GET /billing/invoices");
    expect(callsTo("GET", BILLING_URL)).toBe(0);
    // An apply did not happen: the definition is at the revision it was.
    expect(after.state.revision).toBe(p.state.revision);
  });

  it("is isolated like everything else: another workspace cannot add to or read a project's sources", async () => {
    await merged();
    const stranger = await googleLogin("eve@example.com");
    const taken = await apply(stranger, definitionOf({ sources: [CORE, BILLING_SOURCE] }));
    expect(taken.status).toBe(409);
    expect(
      (await call("/api/projects/test/document", { headers: { cookie: stranger } })).status,
    ).toBe(404);
  });

  it("gives the editor the assembled document", async () => {
    const { cookie } = await merged();
    const response = await call("/api/projects/test/document", { headers: { cookie } });
    expect(response.status).toBe(200);
    const doc = (await response.json()) as Doc;
    expect(Object.keys(doc.paths)).toEqual(["/pets", "/internal/flush", "/invoices"]);
  });
});

describe("a hostile document", () => {
  it("is refused, and leaves every other request as it was", async () => {
    const cookie = await login();
    serveSpec();
    const hostileUrl = "https://hostile.example.com/openapi.json";
    const body = `{
      "openapi": "3.1.0",
      "info": { "title": "Hostile", "version": "1" },
      "paths": { "/x": { "get": { "responses": { "200": { "description": "ok" } } } } },
      "components": { "__proto__": { "sources": [{ "url": "https://evil.example.com/payload.json" }], "slug": "taken-over" } }
    }`;
    upstream(
      "GET",
      hostileUrl,
      () => new Response(body, { headers: { "content-type": "application/json" } }),
    );
    const hostile = { name: "hostile", url: hostileUrl, follow: true, pathPrefix: "/h" };

    // On its own, as part of a merge, uploaded, and added to a project that exists.
    const alone = await apply(
      cookie,
      definitionOf({ sources: [{ url: hostileUrl, follow: true }] }),
    );
    expect(alone.status).toBe(422);
    expect(await alone.json()).toMatchObject({ code: "invalid-spec" });
    const together = await apply(cookie, definitionOf({ sources: [CORE, hostile] }));
    expect(together.status).toBe(422);
    const uploaded = await apply(cookie, definitionOf({ sources: [{ file: "hostile.json" }] }), {
      documents: { main: document(body) },
    });
    expect(uploaded.status).toBe(422);
    const project = await createProject(cookie);
    const added = await sourcesOf(cookie, [CORE, hostile]);
    expect(added.status).toBe(422);

    // Nothing leaked into the objects every request is made of.
    expect(({} as Record<string, unknown>).sources).toBeUndefined();
    expect(({} as Record<string, unknown>).slug).toBeUndefined();
    await applied(edit(cookie, "test", (definition) => ({ ...definition, name: "Still mine" })));
    expect((await getProject(cookie)).definition).toEqual({
      ...project.definition,
      name: "Still mine",
    });
  });
});

describe("a document built to be expensive", () => {
  it("is turned away with a reason, not with a crash", async () => {
    const cookie = await login();
    const deep = "https://deep.example.com/openapi.json";
    // Nested far deeper than anything can walk, inside an operation.
    const body = `{"openapi":"3.1.0","info":{"title":"Deep","version":"1"},"paths":{"/x":{"get":{"responses":{"200":{"description":"ok"}},"x-deep":${"[".repeat(40_000)}${"]".repeat(40_000)}}}}}`;
    upstream(
      "GET",
      deep,
      () => new Response(body, { headers: { "content-type": "application/json" } }),
    );
    const refused = await apply(cookie, definitionOf({ sources: [{ url: deep, follow: true }] }));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      code: "invalid-spec",
      error: expect.stringContaining("nested more than 200 levels"),
    });
  });

  it("is tried once when it cannot be served, and again when what is asked of it changes", async () => {
    const cookie = await login();
    const url = "https://chain.example.com/openapi.json";
    // Twelve operations, each holding something 150 levels deep that ends in
    // a reference into the next. Every level is fine; a variant that serves
    // only the first has to copy all twelve into each other.
    const ok = { "200": { description: "ok" } };
    const deep = (end: object) => {
      let node: object = end;
      for (let level = 0; level < 150; level++) node = { level: node };
      return node;
    };
    const paths: Record<string, unknown> = {
      "/kept": { get: { responses: ok, "x-uses": { $ref: "#/paths/~1t0/get/x-deep" } } },
    };
    for (let n = 0; n < 12; n++) {
      paths[`/t${n}`] = {
        get: {
          responses: ok,
          "x-deep": deep(n < 11 ? { $ref: `#/paths/~1t${n + 1}/get/x-deep` } : { end: true }),
        },
      };
    }
    serveSpec({ openapi: "3.1.0", info: { title: "Chain", version: "1" }, paths }, {}, url);
    await createProject(cookie, { sources: [{ url, follow: true }] });
    const one = await createVariant(cookie, "test", "one", {
      include: { operations: ["GET /kept"] },
    });

    for (const format of ["json", "yaml"]) {
      const refused = await call(`${one.path}.${format}`);
      expect(refused.status).toBe(500);
      expect(await refused.json()).toMatchObject({
        code: "transform-failed",
        error: expect.stringContaining("400 levels deep"),
      });
    }
    // HEAD is GET without the body: it does not say a document is there.
    expect((await call(`${one.path}.json`, { method: "HEAD" })).status).toBe(500);

    // A second request does no work. With the stored documents swapped for
    // something unreadable, it still gives the reason found the first time.
    const stored = await sql("SELECT id, body FROM sources");
    await sql("UPDATE sources SET body = 'unreadable'");
    const again = await call(`${one.path}.json`);
    expect(again.status).toBe(500);
    expect(await again.json()).toMatchObject({ error: expect.stringContaining("400 levels deep") });
    for (const row of stored.results as Array<{ id: string; body: string }>) {
      await sql("UPDATE sources SET body = ? WHERE id = ?", row.body, row.id);
    }

    // The reason belongs to this selection of this document. A selection that
    // can be served is tried, and served.
    await applied(edit(cookie, "test", (definition) => ({ ...definition, variants: { one: {} } })));
    const fine = await call(`${one.path}.json`);
    expect(fine.status).toBe(200);
    expect(Object.keys(((await fine.json()) as { paths: object }).paths)).toHaveLength(13);
  });

  it("does not spend time on a path prefix that is not one", async () => {
    const cookie = await login();
    serveSpec();
    await createProject(cookie);
    const started = Date.now();
    const refused = await sourcesOf(cookie, [
      { url: SPEC_URL, follow: true, pathPrefix: `${"/".repeat(400_000)}a` },
    ]);
    expect(refused.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("changing a project while it is being checked", () => {
  it("never leaves the project describing documents it does not have", async () => {
    const { cookie } = await merged();
    // The main source has a new document, which a check is going to find...
    const next = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
    next.paths["/owners"] = { get: { tags: ["pets"], responses: ok } };
    serveSpec(next);
    // ...in the middle of an apply: after it read the project, and before it
    // writes. The apply adds a third document, and the check runs while that
    // one is being fetched.
    const extraUrl = "https://extra.example.com/openapi.json";
    let checks = 0;
    upstream("GET", extraUrl, async () => {
      if (checks++ === 0) {
        const check = await call("/api/projects/test/check", {
          method: "POST",
          headers: { cookie },
        });
        expect(await check.json()).toMatchObject({ changed: true, addedOps: ["GET /owners"] });
      }
      return Response.json({
        openapi: "3.1.0",
        info: { title: "Extra", version: "1" },
        paths: { "/extra": { get: { responses: ok } } },
      });
    });

    const result = await applied(
      sourcesOf(cookie, [
        CORE,
        { ...BILLING_SOURCE, name: "money" },
        { name: "extra", url: extraUrl, follow: true },
      ]),
    );
    expect(checks).toBe(1);
    // It did not report the check's finding as its own.
    expect(result.operations.added).toEqual(["GET /extra"]);

    const after = await getProject(cookie);
    // The rename, the new document and the check's new operation are all there, and agree.
    expect(after.state.sources.map((source) => source.name)).toEqual(["core", "money", "extra"]);
    expect(keys(after)).toEqual([
      "GET /pets",
      "POST /pets",
      "POST /internal/flush",
      "GET /owners",
      "GET /invoices",
      "GET /extra",
    ]);
    expect(after.state.operations.find((op) => op.key === "GET /invoices")?.source).toBe("money");
    const everything = await variant(cookie);
    expect(Object.keys((await served(everything.path)).paths)).toEqual([
      "/pets",
      "/internal/flush",
      "/owners",
      "/invoices",
      "/extra",
    ]);
  });

  it("tells the second of two people who save at once to reload", async () => {
    const { cookie, project } = await merged();
    const rename = (name: string) =>
      apply(cookie, { ...project.definition, name }, { ifRevision: project.state.revision });
    expect((await rename("First")).status).toBe(200);
    const second = await rename("Second");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "conflict" });
    expect((await getProject(cookie)).definition.name).toBe("First");
  });
});

describe("keeping a merged project current", () => {
  it("checks each source, and assembles again when one of them changes", async () => {
    const { cookie } = await merged();
    const everything = await variant(cookie);
    const before = (await call(everything.path)).headers.get("etag");
    const coreCalls = callsTo("GET", SPEC_URL);
    const billingCalls = callsTo("GET", BILLING_URL);

    const next = structuredClone(BILLING) as typeof BILLING & { paths: Record<string, unknown> };
    next.paths["/refunds"] = { post: { tags: ["billing"], responses: ok } };
    serveSpec(next, {}, BILLING_URL);
    await sql("UPDATE projects SET next_check_at = ?", Date.now() - 1);
    await runTimer();

    const response = await call(everything.path);
    expect(response.headers.get("x-proxy-source-status")).toBe("fresh");
    expect(response.headers.get("etag")).not.toBe(before);
    expect(Object.keys(((await response.json()) as Doc).paths)).toContain("/refunds");
    // Both were asked, once each.
    expect(callsTo("GET", SPEC_URL) - coreCalls).toBe(1);
    expect(callsTo("GET", BILLING_URL) - billingCalls).toBe(1);
    expect(
      (await getProject(cookie)).state.operations.find((op) => op.key === "POST /refunds")?.source,
    ).toBe("billing");
  });

  it("keeps serving, and keeps updating the others, when one source is down", async () => {
    const { cookie } = await merged();
    const everything = await variant(cookie);

    upstream("GET", BILLING_URL, () => new Response("boom", { status: 500 }));
    const next = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
    next.paths["/owners"] = { get: { tags: ["pets"], responses: ok } };
    serveSpec(next);
    await sql("UPDATE projects SET next_check_at = ?", Date.now() - 1);
    await runTimer();

    const response = await call(everything.path);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-proxy-source-status")).toBe("stale-error");
    const paths = Object.keys(((await response.json()) as Doc).paths);
    // The new operation of the healthy source is there, and so is the last good copy of the other.
    expect(paths).toContain("/owners");
    expect(paths).toContain("/invoices");

    const after = await getProject(cookie);
    expect(after.state.check?.lastError).toContain("billing: The source responded with HTTP 500.");
    expect(after.state.sources.map((source) => source.lastStatus)).toEqual(["ok", "error"]);
  });

  it("emails about a change in any source, once", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    await merged(ada);
    await variant(ada);

    const sent = mailbox();
    const next = structuredClone(BILLING) as typeof BILLING & { paths: Record<string, unknown> };
    next.paths["/refunds"] = { post: { tags: ["billing"], responses: ok } };
    serveSpec(next, {}, BILLING_URL);
    await call("/api/projects/test/check", { method: "POST", headers: { cookie: ada } }, MAIL);

    expect(sent.map((email) => email.subject)).toEqual(["test: 1 new"]);
    expect(sent[0]?.text).toContain("POST /refunds: served by Everything");
  });
});

describe("the OpenAPI version of a variant", () => {
  const OLD_URL = "https://legacy.example.com/openapi.json";
  const OLD = {
    openapi: "3.0.3",
    info: { title: "Legacy API", version: "1" },
    paths: {
      "/legacy": {
        get: {
          parameters: [{ name: "q", in: "query", schema: { type: "string", nullable: true } }],
          responses: ok,
        },
      },
    },
  };
  /** The schema of the first parameter of GET <path>. */
  const schemaOfQ = (doc: Doc, path: string) => {
    const get = doc.paths[path]?.get as { parameters?: Array<{ schema: unknown }> } | undefined;
    return get?.parameters?.[0]?.schema;
  };

  it("is the document's own at the plain URL, and each version at a path of its own", async () => {
    const cookie = await login();
    serveSpec(OLD, {}, OLD_URL);
    const p = await createProject(cookie, { sources: [{ url: OLD_URL, follow: true }] });
    expect(p.state.specVersion).toBe("3.0");
    const v = await variant(cookie, { name: "As is" });
    // One source, served in its own version: byte for byte what the source sent.
    expect(await textOf(await call(`${v.path}.json`))).toBe(JSON.stringify(OLD));

    // The other version is there without anyone having set it up.
    const newer = (await (await call(`${v.path}/3.1.json`)).json()) as Doc;
    expect(newer.openapi).toBe("3.1.0");
    expect(schemaOfQ(newer, "/legacy")).toEqual({ type: ["string", "null"] });
    // In either format, by extension or by the Accept header.
    const yaml = await call(`${v.path}/3.1.yaml`);
    expect(yaml.headers.get("content-type")).toContain("yaml");
    expect(await yaml.text()).toContain("openapi: 3.1.0");
    const negotiated = await call(`${v.path}/3.1`, { headers: { accept: "application/yaml" } });
    expect(negotiated.headers.get("content-type")).toContain("yaml");
    expect(negotiated.headers.get("vary")).toBe("Accept");
    // Asked for by name, the version it already has is the plain URL's document.
    const own = await call(`${v.path}/3.0.json`);
    expect(await textOf(own)).toBe(JSON.stringify(OLD));

    // Each representation has a validator of its own, and answers to it.
    const plain = await call(`${v.path}.json`);
    const converted = await call(`${v.path}/3.1.json`);
    expect(own.headers.get("etag")).toBe(plain.headers.get("etag"));
    expect(converted.headers.get("etag")).not.toBe(plain.headers.get("etag"));
    expect(yaml.headers.get("etag")).not.toBe(converted.headers.get("etag"));
    const again = await call(`${v.path}/3.1.json`, {
      headers: { "if-none-match": converted.headers.get("etag") as string },
    });
    expect(again.status).toBe(304);
    // Each is stored once, next to the others.
    expect(
      (await sql("SELECT format, version FROM variant_outputs ORDER BY version, format")).results,
    ).toEqual([
      { format: "json", version: "3.1" },
      { format: "yaml", version: "3.1" },
      { format: "json", version: "own" },
    ]);

    // A version there is none of is not found, and says what there is.
    const none = await call(`${v.path}/2.0.json`);
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toContain("/3.0 and /3.1");
  });

  it("lets a 3.0 document be merged with a newer one by converting it, and says so", async () => {
    const cookie = await login();
    serveSpec();
    serveSpec(OLD, {}, OLD_URL);
    await createProject(cookie);
    await applied(sourcesOf(cookie, [CORE, { name: "legacy", url: OLD_URL, follow: true }]));
    const p = await getProject(cookie);

    expect(p.state.specVersion).toBe("3.1");
    expect(p.state.notes).toContainEqual({
      kind: "source-converted",
      source: "legacy",
      from: "3.0",
      to: "3.1",
    });
    const v = await variant(cookie);
    const doc = await served(v.path);
    expect(doc.openapi).toBe("3.1.0");
    expect(schemaOfQ(doc, "/legacy")).toEqual({ type: ["string", "null"] });
  });
});
