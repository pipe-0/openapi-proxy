import { describe, expect, it } from "vitest";
import {
  type ApiProject,
  type ApiVariant,
  call,
  callsTo,
  createProject,
  json,
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

const project = async (cookie: string, id: string) =>
  (await (await call(`/api/projects/${id}`, { headers: { cookie } })).json()) as ApiProject;
const addSource = (cookie: string, id: string, body: object, bindings = {}) =>
  call(`/api/projects/${id}/sources`, json("POST", body, cookie), bindings);
const keys = (p: ApiProject) => p.operations.map((op) => op.key);

async function variant(cookie: string, projectId: string, body: object = {}) {
  const response = await call(
    "/api/variants",
    json(
      "POST",
      {
        projectId,
        name: "Everything",
        selection: {},
        ...body,
      },
      cookie,
    ),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as ApiVariant;
}
const served = async (path: string) => (await (await call(`${path}.json`)).json()) as Doc;

/** Core and Billing, merged, with Billing added after the project existed. */
async function merged() {
  const cookie = await login();
  serveSpec();
  serveSpec(BILLING, {}, BILLING_URL);
  const created = await createProject(cookie);
  const response = await addSource(cookie, created.id, { url: BILLING_URL });
  expect(response.status, await response.clone().text()).toBe(201);
  return { cookie, project: (await response.json()) as ApiProject };
}

describe("merging several documents into one project", () => {
  it("adds a document to an existing project: its operations join, and each knows where it came from", async () => {
    const { project: p } = await merged();
    expect(p.sources.map((source) => [source.name, source.url, source.operations])).toEqual([
      ["Test API", SPEC_URL, 3],
      ["Billing API", BILLING_URL, 2],
    ]);
    expect(keys(p)).toEqual(["GET /pets", "POST /pets", "POST /internal/flush", "GET /invoices"]);
    expect(Object.fromEntries(p.operations.map((op) => [op.key, op.source]))).toEqual({
      "GET /pets": "Test API",
      "POST /pets": "Test API",
      "POST /internal/flush": "Test API",
      "GET /invoices": "Billing API",
    });
  });

  it("says what merging did: an operation left out, a component renamed, servers not carried over", async () => {
    const { project: p } = await merged();
    expect(p.notes).toEqual(
      expect.arrayContaining([
        {
          kind: "operation-left-out",
          source: "Billing API",
          operation: "GET /pets",
          keptFrom: "Test API",
        },
        {
          kind: "component-renamed",
          source: "Billing API",
          group: "schemas",
          from: "Pet",
          to: "BillingPet",
        },
        { kind: "servers-differ", source: "Billing API" },
      ]),
    );
  });

  it("serves the merged document: the main one's top level, every operation with the schema it had", async () => {
    const { cookie, project: p } = await merged();
    const everything = await variant(cookie, p.id);
    const doc = await served(everything.path);

    expect(doc.info.title).toBe("Test API");
    expect(JSON.stringify(doc)).not.toContain("billing.internal");
    expect(Object.keys(doc.paths)).toEqual(["/pets", "/internal/flush", "/invoices"]);
    expect(JSON.stringify(doc.paths["/invoices"])).toContain("#/components/schemas/BillingPet");
    expect(JSON.stringify(doc.paths["/pets"])).toContain('#/components/schemas/Pet"');
    expect(doc.components?.schemas).toHaveProperty("BillingPet.properties.invoiceId");
    expect(doc.components?.schemas).toHaveProperty("Pet.properties.name");

    // A variant of only the second service carries only what that needs.
    const billing = await variant(cookie, p.id, {
      name: "Billing",
      selection: { include: { tags: ["billing"] } },
    });
    const only = await served(billing.path);
    expect(Object.keys(only.paths)).toEqual(["/invoices"]);
    expect(Object.keys(only.components?.schemas ?? {})).toEqual(["BillingPet"]);
  });

  it("can be created from several documents at once, in order", async () => {
    const cookie = await login();
    serveSpec();
    serveSpec(BILLING, {}, BILLING_URL);
    const created = await call(
      "/api/projects",
      json(
        "POST",
        { sources: [{ url: BILLING_URL }, { url: SPEC_URL, pathPrefix: "core" }] },
        cookie,
      ),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const p = (await created.json()) as ApiProject;
    // The first document is the main one: the project is named after it.
    expect(p.name).toBe("Billing API");
    expect(p.sources.map((source) => [source.name, source.pathPrefix])).toEqual([
      ["Billing API", null],
      ["Test API", "/core"],
    ]);
    expect(keys(p)).toEqual([
      "GET /invoices",
      "GET /pets",
      "GET /core/pets",
      "POST /core/pets",
      "POST /core/internal/flush",
    ]);
  });

  it("mounts a document under a path prefix, and lets the main document be chosen", async () => {
    const { cookie, project: p } = await merged();
    const billing = p.sources[1]?.id;

    const prefixed = await call(
      `/api/projects/${p.id}/sources/${billing}`,
      json("PATCH", { pathPrefix: "/billing", name: "Money" }, cookie),
    );
    const afterPrefix = (await prefixed.json()) as ApiProject;
    expect(keys(afterPrefix)).toEqual([
      "GET /pets",
      "POST /pets",
      "POST /internal/flush",
      "GET /billing/invoices",
      "GET /billing/pets",
    ]);
    // The component is named after the document's new name.
    expect(afterPrefix.notes).toContainEqual(
      expect.objectContaining({ kind: "component-renamed", to: "MoneyPet" }),
    );

    const promoted = await call(`/api/projects/${p.id}/sources/${billing}/main`, {
      method: "POST",
      headers: { cookie, origin: "https://proxy.test" },
    });
    const afterMain = (await promoted.json()) as ApiProject;
    expect(afterMain.sources.map((source) => source.name)).toEqual(["Money", "Test API"]);
    const everything = await variant(cookie, p.id);
    expect((await served(everything.path)).info.title).toBe("Billing API");
  });

  it("takes a document out again; what a variant selected from it comes back if it does", async () => {
    const { cookie, project: p } = await merged();
    const picked = await variant(cookie, p.id, {
      selection: { include: { operations: ["GET /invoices", "GET /pets"] } },
    });
    expect(Object.keys((await served(picked.path)).paths)).toEqual(["/pets", "/invoices"]);

    const removed = await call(`/api/projects/${p.id}/sources/${p.sources[1]?.id}`, {
      method: "DELETE",
      headers: { cookie, origin: "https://proxy.test" },
    });
    const after = (await removed.json()) as ApiProject;
    expect(after.sources).toHaveLength(1);
    expect(after.notes).toEqual([]);
    expect(Object.keys((await served(picked.path)).paths)).toEqual(["/pets"]);

    // The last document cannot be removed.
    const last = await call(`/api/projects/${p.id}/sources/${after.sources[0]?.id}`, {
      method: "DELETE",
      headers: { cookie, origin: "https://proxy.test" },
    });
    expect(last.status).toBe(409);

    await addSource(cookie, p.id, { url: BILLING_URL });
    expect(Object.keys((await served(picked.path)).paths)).toEqual(["/pets", "/invoices"]);
  });

  it("refuses a document that cannot be fetched or is already there, and leaves the project as it was", async () => {
    const { cookie, project: p } = await merged();
    expect((await addSource(cookie, p.id, { url: BILLING_URL })).status).toBe(409);

    upstream(
      "GET",
      "https://down.example.com/openapi.json",
      () => new Response("no", { status: 500 }),
    );
    const failed = await addSource(cookie, p.id, { url: "https://down.example.com/openapi.json" });
    expect(failed.status).toBe(422);
    expect((await project(cookie, p.id)).sources).toHaveLength(2);
  });

  it("is isolated like everything else: another workspace cannot add to or read a project's sources", async () => {
    const { project: p } = await merged();
    const { googleLogin } = await import("./harness");
    const stranger = await googleLogin("eve@example.com");
    expect((await addSource(stranger, p.id, { url: BILLING_URL })).status).toBe(404);
    const patch = await call(
      `/api/projects/${p.id}/sources/${p.sources[0]?.id}`,
      json("PATCH", { name: "Mine" }, stranger),
    );
    expect(patch.status).toBe(404);
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

    // On its own, as part of a merge, and added to a project that exists.
    const alone = await call("/api/projects", json("POST", { url: hostileUrl }, cookie));
    expect(alone.status).toBe(422);
    expect(await alone.json()).toMatchObject({ code: "invalid-spec" });
    const together = await call(
      "/api/projects",
      json("POST", { sources: [{ url: SPEC_URL }, { url: hostileUrl, pathPrefix: "/h" }] }, cookie),
    );
    expect(together.status).toBe(422);
    const project = await createProject(cookie);
    const added = await call(
      `/api/projects/${project.id}/sources`,
      json("POST", { url: hostileUrl, pathPrefix: "/h" }, cookie),
    );
    expect(added.status).toBe(422);

    // Nothing leaked into the objects every request is made of.
    expect(({} as Record<string, unknown>).sources).toBeUndefined();
    expect(({} as Record<string, unknown>).slug).toBeUndefined();
    const renamed = await call(
      `/api/projects/${project.id}`,
      json("PATCH", { name: "Still mine" }, cookie),
    );
    expect(await renamed.json()).toMatchObject({ name: "Still mine", slug: project.slug });
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
    const refused = await call("/api/projects", json("POST", { url: deep }, cookie));
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
    const project = await createProject(cookie, { url });
    const created = await call(
      "/api/variants",
      json(
        "POST",
        {
          projectId: project.id,
          name: "One",
          selection: { include: { operations: ["GET /kept"] } },
        },
        cookie,
      ),
    );
    const variant = (await created.json()) as ApiVariant;

    for (const format of ["json", "yaml"]) {
      const refused = await call(`${variant.path}.${format}`);
      expect(refused.status).toBe(500);
      expect(await refused.json()).toMatchObject({
        code: "transform-failed",
        error: expect.stringContaining("400 levels deep"),
      });
    }
    // HEAD is GET without the body: it does not say a document is there.
    expect((await call(`${variant.path}.json`, { method: "HEAD" })).status).toBe(500);

    // A second request does no work. With the stored documents swapped for
    // something unreadable, it still gives the reason found the first time.
    const stored = await sql("SELECT id, body FROM sources WHERE project_id = ?", project.id);
    await sql("UPDATE sources SET body = 'unreadable' WHERE project_id = ?", project.id);
    const again = await call(`${variant.path}.json`);
    expect(again.status).toBe(500);
    expect(await again.json()).toMatchObject({ error: expect.stringContaining("400 levels deep") });
    for (const row of stored.results as Array<{ id: string; body: string }>) {
      await sql("UPDATE sources SET body = ? WHERE id = ?", row.body, row.id);
    }

    // The reason belongs to this selection of this document. A selection that
    // can be served is tried, and served.
    await call(`/api/variants/${variant.id}`, json("PATCH", { selection: {} }, cookie));
    const served = await call(`${variant.path}.json`);
    expect(served.status).toBe(200);
    expect(Object.keys(((await served.json()) as { paths: object }).paths)).toHaveLength(13);
  });

  it("does not spend time on a path prefix that is not one", async () => {
    const cookie = await login();
    serveSpec();
    const project = await createProject(cookie);
    const started = Date.now();
    const refused = await call(
      `/api/projects/${project.id}/sources/${project.sources[0]?.id}`,
      json("PATCH", { pathPrefix: `${"/".repeat(400_000)}a` }, cookie),
    );
    expect(refused.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("editing a project while it is being checked", () => {
  it("never leaves the project describing documents it does not have", async () => {
    const { cookie, project: p } = await merged();
    // A check stores a new document for the main source...
    const next = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
    next.paths["/owners"] = { get: { tags: ["pets"], responses: ok } };
    serveSpec(next);
    // ...after this request read the project, but before it writes: simulated
    // by handing the request a picture of the project that is already old.
    await call(`/api/projects/${p.id}/check`, { method: "POST", headers: { cookie } });
    await sql("UPDATE projects SET body_hash = 'out-of-date' WHERE id = ?", p.id);

    const renamed = await call(
      `/api/projects/${p.id}/sources/${p.sources[1]?.id}`,
      json("PATCH", { name: "Money" }, cookie),
    );
    expect(renamed.status).toBe(200);
    const after = (await renamed.json()) as ApiProject;
    // Both the rename and the new operation are there, and the two agree.
    expect(after.sources[1]?.name).toBe("Money");
    expect(keys(after)).toContain("GET /owners");
    expect(after.operations.find((op) => op.key === "GET /invoices")?.source).toBe("Money");
  });
});

describe("keeping a merged project current", () => {
  it("checks each source, and assembles again when one of them changes", async () => {
    const { cookie, project: p } = await merged();
    const everything = await variant(cookie, p.id);
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
      (await project(cookie, p.id)).operations.find((op) => op.key === "POST /refunds")?.source,
    ).toBe("Billing API");
  });

  it("keeps serving, and keeps updating the others, when one source is down", async () => {
    const { cookie, project: p } = await merged();
    const everything = await variant(cookie, p.id);

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

    const after = await project(cookie, p.id);
    expect(after.lastError).toContain("Billing API: The source responded with HTTP 500.");
    expect(after.sources.map((source) => source.lastStatus)).toEqual(["ok", "error"]);
  });

  it("emails about a change in any source, once", async () => {
    const { googleLogin } = await import("./harness");
    const ada = await googleLogin("ada@example.com", "Ada");
    serveSpec();
    serveSpec(BILLING, {}, BILLING_URL);
    const created = await createProject(ada);
    await addSource(ada, created.id, { url: BILLING_URL });
    await variant(ada, created.id);

    const sent = mailbox();
    const next = structuredClone(BILLING) as typeof BILLING & { paths: Record<string, unknown> };
    next.paths["/refunds"] = { post: { tags: ["billing"], responses: ok } };
    serveSpec(next, {}, BILLING_URL);
    await call(
      `/api/projects/${created.id}/check`,
      { method: "POST", headers: { cookie: ada } },
      MAIL,
    );

    expect(sent.map((email) => email.subject)).toEqual(["Test API: 1 new"]);
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
    const p = await createProject(cookie, { url: OLD_URL });
    expect(p.specVersion).toBe("3.0");
    const v = await variant(cookie, p.id, { name: "As is" });
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
    const created = await createProject(cookie);
    const p = (await (await addSource(cookie, created.id, { url: OLD_URL })).json()) as ApiProject;

    expect(p.specVersion).toBe("3.1");
    expect(p.notes).toContainEqual({
      kind: "source-converted",
      source: "Legacy API",
      from: "3.0",
      to: "3.1",
    });
    const v = await variant(cookie, p.id);
    const doc = await served(v.path);
    expect(doc.openapi).toBe("3.1.0");
    expect(schemaOfQ(doc, "/legacy")).toEqual({ type: ["string", "null"] });
  });
});
