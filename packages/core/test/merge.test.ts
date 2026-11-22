import { validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import {
  applyVariant,
  indexOperations,
  type JsonObject,
  MergeError,
  type MergePart,
  mergeDocuments,
  normalizePathPrefix,
  type OpenAPIDocument,
} from "../src/index.js";
import { expectSecuritySchemesResolve, expectSelfContained, loadFixture } from "./helpers.js";

const ok = { "200": { description: "ok" } };
const returns = (schema: string) => ({
  "200": {
    description: "ok",
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  },
});

/** The main API: books, with an `Error` schema and bearer auth. */
const core = (): OpenAPIDocument => ({
  openapi: "3.1.0",
  info: { title: "Core API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  security: [{ bearer: [] }],
  tags: [{ name: "Books", description: "Everything about books" }],
  paths: {
    "/books": {
      get: { operationId: "list", tags: ["Books"], responses: returns("Book") },
      post: {
        operationId: "create",
        tags: ["Books"],
        responses: { ...returns("Book"), default: errorRef() },
      },
    },
    "/books/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "get", tags: ["Books"], responses: returns("Book") },
    },
  },
  components: {
    schemas: {
      Book: { type: "object", properties: { title: { type: "string" } } },
      Error: { type: "object", properties: { message: { type: "string" } } },
      Money: { type: "object", properties: { amount: { type: "integer" } } },
    },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
});

/** A second service: invoices, with an `Error` that means something else. */
const billing = (): OpenAPIDocument => ({
  openapi: "3.1.0",
  info: { title: "Billing API", version: "7" },
  servers: [{ url: "https://billing.internal" }],
  tags: [{ name: "Invoices" }, { name: "Books", description: "ignored: the first one stands" }],
  paths: {
    "/invoices": {
      get: {
        operationId: "list",
        tags: ["Invoices"],
        responses: { ...returns("Invoice"), default: errorRef() },
      },
    },
    "/books": {
      // Collides with the main document.
      get: { operationId: "billingBooks", responses: ok },
      // Does not: a new method on a path both have.
      delete: { operationId: "purge", responses: ok },
    },
  },
  components: {
    schemas: {
      Invoice: {
        type: "object",
        properties: {
          total: { $ref: "#/components/schemas/Money" },
          problem: { $ref: "#/components/schemas/Error" },
        },
      },
      // Same name, different meaning.
      Error: { type: "object", properties: { code: { type: "integer" } } },
      // Same name, same meaning.
      Money: { type: "object", properties: { amount: { type: "integer" } } },
    },
  },
});

function errorRef() {
  return {
    description: "error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

const parts = (...docs: Array<[string, OpenAPIDocument, string?]>): MergePart[] =>
  docs.map(([name, doc, pathPrefix]) => ({ name, doc, pathPrefix }));
const keys = (doc: OpenAPIDocument) => indexOperations(doc).entries.map((entry) => entry.key);
const schemas = (doc: OpenAPIDocument) =>
  ((doc.components as JsonObject | undefined)?.schemas ?? {}) as Record<string, JsonObject>;
const at = (doc: OpenAPIDocument, path: string, method: string) =>
  ((doc.paths as JsonObject)[path] as JsonObject)[method] as JsonObject;

describe("merging one document", () => {
  it("gives it back untouched", () => {
    const doc = core();
    const merged = mergeDocuments(parts(["Core", doc]));
    expect(merged.doc).toBe(doc);
    expect(merged.notes).toEqual([]);
    expect([...merged.origins.values()]).toEqual(["Core", "Core", "Core"]);
  });
});

describe("merging two documents", () => {
  const merge = () => mergeDocuments(parts(["Core API", core()], ["Billing API", billing()]));

  it("combines their operations, and says where each came from", () => {
    const { doc, origins } = merge();
    expect(keys(doc)).toEqual([
      "GET /books",
      "POST /books",
      "DELETE /books",
      "GET /books/{id}",
      "GET /invoices",
    ]);
    expect(Object.fromEntries(origins)).toEqual({
      "GET /books": "Core API",
      "POST /books": "Core API",
      "GET /books/{id}": "Core API",
      "GET /invoices": "Billing API",
      "DELETE /books": "Billing API",
    });
  });

  it("takes everything at the top level from the first document, and says what it did not carry over", () => {
    const { doc, notes } = merge();
    expect(doc.info).toEqual({ title: "Core API", version: "1.0.0" });
    expect(doc.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(doc.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(doc)).toEqual(Object.keys(core()));
    expect(notes).toContainEqual({ kind: "servers-differ", source: "Billing API" });
    // The internal host of the second service appears nowhere.
    expect(JSON.stringify(doc)).not.toContain("billing.internal");
  });

  it("lets every operation keep the security its own document gave it", () => {
    // The main document asks for a bearer token by default. The second asks for nothing.
    const { doc } = merge();
    expect(at(doc, "/books", "get").security).toBeUndefined();
    expect(at(doc, "/invoices", "get").security).toEqual([]);
    expect(at(doc, "/books", "delete").security).toEqual([]);

    // The other way round: only the second document has a default, with a scheme of its own.
    const open: OpenAPIDocument = { ...core() };
    delete open.security;
    const keyed: OpenAPIDocument = {
      ...billing(),
      security: [{ bearer: ["invoices"] }],
      paths: {
        "/invoices": { get: { responses: ok }, post: { security: [], responses: ok } },
      },
      webhooks: { paid: { post: { responses: ok } } },
      components: {
        securitySchemes: { bearer: { type: "apiKey", in: "header", name: "X-Billing-Key" } },
        pathItems: { Shared: { get: { responses: ok } } },
      },
    };
    const merged = mergeDocuments(parts(["Core API", open], ["Billing API", keyed])).doc;
    expect(merged.security).toBeUndefined();
    // Stated on the operation, under the name the scheme was given in the merged document.
    expect(at(merged, "/invoices", "get").security).toEqual([{ BillingBearer: ["invoices"] }]);
    // An operation that said "none" still says "none".
    expect(at(merged, "/invoices", "post").security).toEqual([]);
    expect(((merged.webhooks as JsonObject).paid as JsonObject).post).toMatchObject({
      security: [{ BillingBearer: ["invoices"] }],
    });
    const shared = (merged.components as JsonObject).pathItems as Record<string, JsonObject>;
    expect(shared.Shared?.get).toMatchObject({ security: [{ BillingBearer: ["invoices"] }] });
    expect(at(merged, "/books", "get").security).toBeUndefined();
    expectSecuritySchemesResolve(merged);
  });

  it("lets the earlier document win an operation both define, and says so", () => {
    const { doc, notes } = merge();
    expect(at(doc, "/books", "get").operationId).toBe("list");
    expect(notes).toContainEqual({
      kind: "operation-left-out",
      source: "Billing API",
      operation: "GET /books",
      keptFrom: "Core API",
    });
  });

  it("shares a component both mean the same by, and renames one they do not", () => {
    const { doc, notes } = merge();
    expect(Object.keys(schemas(doc))).toEqual([
      "Book",
      "Error",
      "Money",
      "Invoice",
      "BillingError",
    ]);
    expect(schemas(doc).Error?.properties).toHaveProperty("message");
    expect(schemas(doc).BillingError?.properties).toHaveProperty("code");
    expect(notes).toContainEqual({
      kind: "component-renamed",
      source: "Billing API",
      group: "schemas",
      from: "Error",
      to: "BillingError",
    });
    // Every reference of the second document followed the rename; the first one's did not move.
    expect(schemas(doc).Invoice?.properties).toMatchObject({
      total: { $ref: "#/components/schemas/Money" },
      problem: { $ref: "#/components/schemas/BillingError" },
    });
    expect(JSON.stringify(at(doc, "/invoices", "get").responses)).toContain("BillingError");
    expect(JSON.stringify(at(doc, "/books", "post").responses)).toContain('schemas/Error"');
  });

  it("keeps operation ids unique", () => {
    const { doc, notes } = merge();
    expect(at(doc, "/invoices", "get").operationId).toBe("Billing_list");
    expect(notes).toContainEqual({
      kind: "operation-id-renamed",
      source: "Billing API",
      from: "list",
      to: "Billing_list",
    });
    const ids = indexOperations(doc).entries.map((entry) => entry.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("combines tags by name, the first description standing", () => {
    expect(merge().doc.tags).toEqual([
      { name: "Books", description: "Everything about books" },
      { name: "Invoices" },
    ]);
  });

  it("produces a valid document that stands on its own, and changes neither input", async () => {
    const a = core();
    const b = billing();
    const before = JSON.stringify([a, b]);
    const { doc } = mergeDocuments(parts(["Core API", a], ["Billing API", b]));
    expect(JSON.stringify([a, b])).toBe(before);
    expectSelfContained(doc);
    expectSecuritySchemesResolve(doc);
    const verdict = await validate(JSON.stringify(doc));
    expect(verdict.errors ?? []).toEqual([]);
  });

  it("can then be filtered like any document", () => {
    const { doc } = merge();
    const invoices = applyVariant(doc, { mode: "include", operations: [], tags: ["Invoices"] });
    expect(keys(invoices.doc)).toEqual(["GET /invoices"]);
    expect(Object.keys(schemas(invoices.doc)).sort()).toEqual(["BillingError", "Invoice", "Money"]);
  });
});

describe("what counts as the same component", () => {
  it("looks at what a component references, not only at its own lines", () => {
    // Both say `Pet: { owner: Owner }`, but they mean different owners.
    const withOwner = (owner: JsonObject): OpenAPIDocument => ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        [`/${Object.keys(owner.properties as object)[0]}`]: { get: { responses: returns("Pet") } },
      },
      components: {
        schemas: {
          Pet: { type: "object", properties: { owner: { $ref: "#/components/schemas/Owner" } } },
          Owner: owner,
        },
      },
    });
    const { doc } = mergeDocuments(
      parts(
        ["First", withOwner({ type: "object", properties: { name: { type: "string" } } })],
        ["Second", withOwner({ type: "object", properties: { email: { type: "string" } } })],
      ),
    );
    expect(Object.keys(schemas(doc))).toEqual(["Pet", "Owner", "SecondPet", "SecondOwner"]);
    expect(schemas(doc).SecondPet?.properties).toEqual({
      owner: { $ref: "#/components/schemas/SecondOwner" },
    });
    expectSelfContained(doc);
  });

  it("follows a rename through discriminator mappings and security requirements", () => {
    const first: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/a": { get: { security: [{ key: [] }], responses: returns("Cat") } } },
      components: {
        schemas: { Cat: { type: "object", properties: { lives: { type: "integer" } } } },
        securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } },
      },
    };
    const second: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/b": { get: { security: [{ key: ["read"] }], responses: returns("Animal") } } },
      components: {
        schemas: {
          Animal: {
            oneOf: [{ $ref: "#/components/schemas/Cat" }],
            discriminator: {
              propertyName: "kind",
              mapping: { cat: "#/components/schemas/Cat", kitten: "Cat" },
            },
          },
          Cat: { type: "object", properties: { kind: { type: "string" } } },
        },
        securitySchemes: { key: { type: "apiKey", in: "query", name: "key" } },
      },
    };
    const { doc } = mergeDocuments(parts(["Zoo", first], ["Vet clinic API", second]));
    expect(schemas(doc).Animal).toEqual({
      oneOf: [{ $ref: "#/components/schemas/VetClinicCat" }],
      discriminator: {
        propertyName: "kind",
        mapping: { cat: "#/components/schemas/VetClinicCat", kitten: "VetClinicCat" },
      },
    });
    expect(at(doc, "/b", "get").security).toEqual([{ VetClinicKey: ["read"] }]);
    expect(at(doc, "/a", "get").security).toEqual([{ key: [] }]);
    expectSelfContained(doc);
    expectSecuritySchemesResolve(doc);
  });

  it("keeps a discriminator value meaning the schema it meant, when that schema is found by name", () => {
    const cats = (schemas: JsonObject, version = "3.1.0"): OpenAPIDocument => ({
      openapi: version,
      info: { title: "t", version: "1" },
      paths: { [`/${Object.keys(schemas)[0]}`]: { get: { responses: ok } } },
      components: { schemas },
    });
    const unrelated = { Cat: { type: "object", properties: { livesLeft: { type: "integer" } } } };

    // Found by name because it extends the family: nothing lists it anywhere.
    const extended = mergeDocuments(
      parts(
        ["Zoo", cats(unrelated)],
        [
          "Vet",
          cats({
            Pet: {
              type: "object",
              properties: { petType: { type: "string" } },
              discriminator: { propertyName: "petType" },
            },
            Cat: { allOf: [{ $ref: "#/components/schemas/Pet" }, { type: "object" }] },
          }),
        ],
      ),
    ).doc;
    // The API still sends petType "Cat", and "Cat" is now the other document's schema.
    expect(schemas(extended).Pet?.discriminator).toEqual({
      propertyName: "petType",
      mapping: { Cat: "#/components/schemas/VetCat" },
    });

    // Found by name because the family lists it, in OpenAPI 3.2 with a default.
    const listed = mergeDocuments(
      parts(
        ["Zoo", cats(unrelated, "3.2.0")],
        [
          "Vet",
          cats(
            {
              Pet: {
                oneOf: [{ $ref: "#/components/schemas/Cat" }],
                discriminator: { propertyName: "kind", defaultMapping: "Cat" },
              },
              Cat: { type: "object", properties: { kind: { type: "string" } } },
            },
            "3.2.0",
          ),
        ],
      ),
    ).doc;
    expect(schemas(listed).Pet?.discriminator).toEqual({
      propertyName: "kind",
      mapping: { Cat: "#/components/schemas/VetCat" },
      defaultMapping: "VetCat",
    });
  });

  it("leaves example data alone, whatever its keys are called", () => {
    // An API that returns OpenAPI documents shows `$ref` and `operationId` in its examples.
    const payload = {
      operationId: "list",
      schema: { $ref: "#/components/schemas/Error" },
      security: [{ bearer: [] }],
    };
    const described: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "Describer API", version: "1" },
      paths: {
        "/operations": {
          get: {
            operationId: "list",
            responses: {
              // A response called "default", next to literal data under `default`.
              default: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      default: payload,
                      examples: [payload],
                      properties: {
                        // Properties named like keywords are still schemas.
                        default: { $ref: "#/components/schemas/Error" },
                        example: { $ref: "#/components/schemas/Error" },
                      },
                    },
                    example: payload,
                    examples: { one: { value: payload } },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: { Error: { type: "object", properties: { code: { type: "integer" } } } },
        securitySchemes: { bearer: { type: "apiKey", in: "query", name: "key" } },
      },
    };
    const { doc } = mergeDocuments(parts(["Core API", core()], ["Describer API", described]));
    const operation = at(doc, "/operations", "get");
    const media = (
      ((operation.responses as JsonObject).default as JsonObject).content as JsonObject
    )["application/json"] as JsonObject;
    const schema = media.schema as JsonObject;

    // The operation's own id and its references were renamed...
    expect(operation.operationId).toBe("Describer_list");
    expect(schema.properties).toEqual({
      default: { $ref: "#/components/schemas/DescriberError" },
      example: { $ref: "#/components/schemas/DescriberError" },
    });
    // ...and what it shows as data was not.
    expect(media.example).toEqual(payload);
    expect((media.examples as JsonObject).one).toEqual({ value: payload });
    expect(schema.default).toEqual(payload);
    expect(schema.examples).toEqual([payload]);
  });
});

describe("documents that did not come through parseSpec", () => {
  it("cannot reach the prototype that all objects share", () => {
    // JSON.parse makes `__proto__` an ordinary key. Reading it back from an
    // ordinary object would give Object.prototype, and writing into that
    // would change every object there is.
    const hostile = JSON.parse(`{
      "openapi": "3.1.0",
      "info": { "title": "Hostile", "version": "1" },
      "paths": {
        "__proto__": { "get": { "responses": {} } },
        "/x": { "get": { "responses": {} }, "__proto__": { "polluted": "path item" } }
      },
      "webhooks": { "__proto__": { "post": { "responses": {} } } },
      "components": {
        "__proto__": { "polluted": { "type": "string" }, "sources": [{ "url": "https://evil.example" }] },
        "schemas": { "__proto__": { "type": "object" }, "Error": { "discriminator": { "propertyName": "k", "mapping": { "__proto__": "Error" } } } }
      }
    }`) as OpenAPIDocument;

    for (const pathPrefix of [undefined, "/billing"]) {
      const { doc } = mergeDocuments([
        { name: "Core API", doc: core() },
        { name: "Hostile", doc: hostile, pathPrefix },
      ]);
      const clean = {} as Record<string, unknown>;
      expect(clean.polluted).toBeUndefined();
      expect(clean.sources).toBeUndefined();
      expect(clean.get).toBeUndefined();
      expect(Object.getPrototypeOf(doc.components)).toBe(Object.prototype);
      // What the document said is still there, as data.
      expect(Object.hasOwn(doc.components as object, "__proto__")).toBe(true);
    }
    // A single document with a prefix goes through the same code.
    mergeDocuments(parts(["Hostile", hostile, "/v2"]));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("paths", () => {
  const one = (path: string, extra: JsonObject = {}): OpenAPIDocument => ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { [path]: { get: { responses: ok }, ...extra } },
  });

  it("can be given a prefix, for a service mounted under the main API", () => {
    const { doc, origins } = mergeDocuments(
      parts(["Core", one("/users")], ["Billing", one("/users"), "billing/"]),
    );
    expect(keys(doc)).toEqual(["GET /users", "GET /billing/users"]);
    expect(origins.get("GET /billing/users")).toBe("Billing");
    expect(normalizePathPrefix(" /billing// ")).toBe("/billing");
    expect(normalizePathPrefix("")).toBeUndefined();
  });

  it("treats paths that differ only in a parameter's name as the same path", () => {
    const { doc, notes } = mergeDocuments(
      parts(["Core", one("/users/{id}")], ["Other", one("/users/{userId}")]),
    );
    expect(keys(doc)).toEqual(["GET /users/{id}"]);
    expect(notes).toEqual([
      {
        kind: "operation-left-out",
        source: "Other",
        operation: "GET /users/{userId}",
        keptFrom: "Core",
      },
    ]);
  });

  it("does not let an operation join a path that is described differently", () => {
    // Both write the same `$ref` at the path, and mean different parameters by it.
    const tenant = (method: string, parameter: JsonObject): OpenAPIDocument => ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/items": {
          parameters: [{ $ref: "#/components/parameters/Tenant" }],
          [method]: { responses: ok },
        },
      },
      components: { parameters: { Tenant: parameter } },
    });
    const header = { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } };
    const query = { name: "tenant", in: "query", schema: { type: "integer" } };

    const differing = mergeDocuments(
      parts(["Core", tenant("get", header)], ["Billing", tenant("post", query)]),
    );
    // Joining would have given POST /items the other document's header parameter.
    expect(keys(differing.doc)).toEqual(["GET /items"]);
    expect(differing.notes).toContainEqual({
      kind: "operation-left-out",
      source: "Billing",
      operation: "POST /items",
      keptFrom: "Core",
      pathDiffers: true,
    });

    const agreeing = mergeDocuments(
      parts(["Core", tenant("get", header)], ["Billing", tenant("post", header)]),
    );
    expect(keys(agreeing.doc)).toEqual(["GET /items", "POST /items"]);
  });

  it("sees the operations of a path item that is a reference", () => {
    const shared = (summary: string): OpenAPIDocument => ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users": { $ref: "#/components/pathItems/Users" },
        "/people": { $ref: "#/components/pathItems/Users" },
      },
      components: {
        pathItems: { Users: { get: { operationId: "users", summary, responses: ok } } },
      },
    });
    const alone = mergeDocuments(parts(["Core", shared("core")]));
    expect(Object.fromEntries(alone.origins)).toEqual({
      "GET /users": "Core",
      "GET /people": "Core",
    });

    const { doc, notes, origins } = mergeDocuments(
      parts(["Core", shared("core")], ["Billing", shared("billing")]),
    );
    expect(keys(doc)).toEqual(["GET /users", "GET /people"]);
    expect(origins.get("GET /users")).toBe("Core");
    // The second document's operations are left out, and it says so.
    expect(notes.filter((note) => note.kind === "operation-left-out")).toEqual([
      { kind: "operation-left-out", source: "Billing", operation: "GET /users", keptFrom: "Core" },
      { kind: "operation-left-out", source: "Billing", operation: "GET /people", keptFrom: "Core" },
    ]);

    // One operation reached from two paths has one id. It is not renamed against itself.
    const beside = mergeDocuments(parts(["Core", one("/a")], ["Billing", shared("billing")]));
    expect(keys(beside.doc)).toEqual(["GET /a", "GET /users", "GET /people"]);
    expect(beside.notes).toEqual([]);
  });

  it("gives a reference into an operation that was left out a copy of what it meant", () => {
    const body = (schema: JsonObject) => ({
      "200": { description: "ok", content: { "application/json": { schema } } },
    });
    const main: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users": {
          get: { responses: body({ type: "object", properties: { id: { type: "string" } } }) },
        },
      },
    };
    // Bundlers point later uses of a schema at the first place it was written.
    const bundled: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users": {
          get: {
            responses: body({ type: "object", properties: { invoices: { type: "integer" } } }),
          },
        },
        "/report": {
          get: {
            responses: body({
              $ref: "#/paths/~1users/get/responses/200/content/application~1json/schema",
            }),
          },
        },
      },
    };
    const { doc } = mergeDocuments(parts(["Core", main], ["Billing", bundled]));
    expect(keys(doc)).toEqual(["GET /users", "GET /report"]);
    // Not the other document's schema, which is what the reference would now find.
    expect(at(doc, "/report", "get").responses).toEqual(
      body({ type: "object", properties: { invoices: { type: "integer" } } }),
    );
  });

  it("moves a link's operationRef with the path it points at", () => {
    const linked: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/invoices": {
          post: {
            responses: {
              "201": {
                description: "made",
                links: { get: { operationRef: "#/paths/~1invoices~1{id}/get" } },
              },
            },
          },
        },
        "/invoices/{id}": { get: { responses: ok } },
      },
    };
    const { doc } = mergeDocuments(parts(["Core", one("/a")], ["Billing", linked, "/billing"]));
    expect(JSON.stringify(at(doc, "/billing/invoices", "post").responses)).toContain(
      '"operationRef":"#/paths/~1billing~1invoices~1{id}/get"',
    );
  });

  it("does not join a path whose shared settings differ", () => {
    const shared = { parameters: [{ name: "tenant", in: "header", schema: { type: "string" } }] };
    const second: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/users": { post: { responses: ok } } },
    };
    const { doc, notes } = mergeDocuments(
      parts(["Core", one("/users", shared)], ["Other", second]),
    );
    // Adding the POST would silently give it the tenant header.
    expect(keys(doc)).toEqual(["GET /users"]);
    expect(notes).toHaveLength(1);
  });

  it("combines webhooks by name", () => {
    const hook = (name: string): OpenAPIDocument => ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      webhooks: { [name]: { post: { responses: ok } } },
    });
    const { doc } = mergeDocuments(
      parts(["A", hook("created")], ["B", hook("created")], ["C", hook("deleted")]),
    );
    expect(keys(doc)).toEqual(["POST webhook:created", "POST webhook:deleted"]);
  });
});

describe("OpenAPI versions", () => {
  const versioned = (openapi: string): OpenAPIDocument => ({
    openapi,
    info: { title: "t", version: "1" },
    paths: { [`/v${openapi}`]: { get: { responses: ok } } },
  });

  it("takes the highest of compatible versions", () => {
    const { doc } = mergeDocuments(parts(["A", versioned("3.1.0")], ["B", versioned("3.2.0")]));
    expect(doc.openapi).toBe("3.2.0");
  });

  it("refuses to mix 3.0 with later versions, and says why", () => {
    expect(() =>
      mergeDocuments(parts(["Old", versioned("3.0.3")], ["New", versioned("3.1.0")])),
    ).toThrow(MergeError);
    expect(() =>
      mergeDocuments(parts(["Old", versioned("3.0.3")], ["New", versioned("3.1.0")])),
    ).toThrow(/Old is OpenAPI 3\.0\.3 and New is 3\.1\.0/);
  });
});

describe("a real document", () => {
  it("merges with a second service and stays valid", async () => {
    const real = loadFixture("pipe0.json");
    const merged = mergeDocuments(parts(["Pipe0", real], ["Billing API", billing(), "/billing"]));
    expect(keys(merged.doc)).toEqual([
      ...keys(real),
      "GET /billing/invoices",
      "GET /billing/books",
      "DELETE /billing/books",
    ]);
    expectSelfContained(merged.doc);
    expectSecuritySchemesResolve(merged.doc);
    const verdict = await validate(JSON.stringify(merged.doc));
    expect(verdict.errors ?? []).toEqual([]);
  });
});
