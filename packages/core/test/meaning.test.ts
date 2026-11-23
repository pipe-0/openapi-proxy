import { describe, expect, it } from "vitest";
import {
  applyVariant,
  assembleDocument,
  buildVariant,
  findExternalRefs,
  fingerprintOperations,
  type JsonObject,
  type OpenAPIDocument,
  parseSpec,
  type Selection,
  SpecParseError,
} from "../src/index.js";
import { expectSelfContained } from "./helpers.js";

/**
 * What a document means is kept, in the places where that is easy to get
 * wrong: keys that only look like keywords, defaults that two documents
 * spell alike and mean differently, families of schemas, and YAML's anchors.
 */

const everything: Selection = {};
const info = { title: "t", version: "1" };
const ok = { "200": { description: "ok" } };
const returning = (schema: string) => ({
  "200": {
    description: "ok",
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  },
});
const doc = (paths: JsonObject, extra: JsonObject = {}): OpenAPIDocument => ({
  openapi: "3.1.0",
  info,
  paths,
  ...extra,
});
const schemasOf = (document: OpenAPIDocument) =>
  Object.keys(((document.components as JsonObject | undefined)?.schemas as JsonObject) ?? {});

describe("a key is a keyword only where the specification says so", () => {
  it("looks inside a property that is called $ref", () => {
    const linked = (uri: JsonObject) =>
      doc(
        { "/a": { get: { responses: returning("Link") } } },
        {
          components: {
            schemas: {
              Link: { type: "object", properties: { $ref: { $ref: "#/components/schemas/Uri" } } },
              Uri: uri,
              Unused: { type: "boolean" },
            },
          },
        },
      );
    const served = applyVariant(linked({ type: "string" }), everything).doc;
    expect(schemasOf(served)).toEqual(["Link", "Uri"]);
    expectSelfContained(served);
    // And a change behind that property is a change to the operation.
    const before = fingerprintOperations(linked({ type: "string" })).get("GET /a");
    const after = fingerprintOperations(linked({ type: "string", format: "uri" })).get("GET /a");
    expect(after).not.toBe(before);
  });

  it("leaves an example alone, whatever it looks like", () => {
    const withExample = doc(
      {
        "/a": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                    example: { $ref: "other.yaml#/Thing", security: [{ nobody: [] }] },
                  },
                },
              },
            },
          },
        },
      },
      { components: { schemas: { Kept: { type: "string" } } } },
    );
    expect(findExternalRefs(withExample)).toEqual([]);
    const merged = assembleDocument([
      { name: "Core", doc: withExample },
      {
        name: "Billing",
        doc: doc({ "/b": { get: { responses: ok } } }, withExample.components as JsonObject),
        pathPrefix: "/billing",
      },
    ]).doc;
    const example = (merged.paths as JsonObject)["/a"] as { get: { responses: JsonObject } };
    expect(JSON.stringify(example.get.responses)).toContain("other.yaml#/Thing");
  });
});

describe("merging keeps what each document meant", () => {
  const keyed = (header: string) => ({
    securitySchemes: { auth: { type: "apiKey", in: "header", name: header } },
  });

  it("a default security that is spelled alike and means something else is stated on the operations", () => {
    const merged = assembleDocument([
      {
        name: "Core",
        doc: doc(
          { "/a": { get: { responses: ok } } },
          { security: [{ auth: [] }], components: keyed("X-Core") },
        ),
      },
      {
        name: "Billing",
        doc: doc(
          { "/b": { get: { responses: ok } } },
          { security: [{ auth: [] }], components: keyed("X-Billing") },
        ),
      },
    ]).doc;
    const paths = merged.paths as Record<string, { get: JsonObject }>;
    expect(paths["/a"]?.get.security).toBeUndefined();
    expect(paths["/b"]?.get.security).toEqual([{ BillingAuth: [] }]);
    // The same default, meaning the same, is left as a default.
    const same = assembleDocument([
      {
        name: "Core",
        doc: doc(
          { "/a": { get: { responses: ok } } },
          { security: [{ auth: [] }], components: keyed("X") },
        ),
      },
      {
        name: "Billing",
        doc: doc(
          { "/b": { get: { responses: ok } } },
          { security: [{ auth: [] }], components: keyed("X") },
        ),
      },
    ]).doc;
    expect((same.paths as Record<string, { get: JsonObject }>)["/b"]?.get.security).toBeUndefined();
  });

  it("a path item both documents have is not shared when their defaults differ", () => {
    const part = (path: string, scheme: string) =>
      doc(
        { [path]: { $ref: "#/components/pathItems/Shared" } },
        {
          security: [{ [scheme]: [] }],
          components: {
            securitySchemes: { [scheme]: { type: "apiKey", in: "header", name: scheme } },
            pathItems: { Shared: { get: { responses: ok } } },
          },
        },
      );
    const merged = assembleDocument([
      { name: "Core", doc: part("/a", "keyA") },
      { name: "Billing", doc: part("/b", "keyB") },
    ]).doc;
    const paths = merged.paths as Record<string, { $ref: string }>;
    const items = (merged.components as { pathItems: Record<string, { get: JsonObject }> })
      .pathItems;
    expect(paths["/b"]?.$ref).toBe("#/components/pathItems/BillingShared");
    expect(items.BillingShared?.get.security).toEqual([{ keyB: [] }]);
    expect(items.Shared?.get.security).toBeUndefined();
  });

  it("a reference to a section of its own that is not carried over gets a copy", () => {
    const merged = assembleDocument([
      {
        name: "Core",
        doc: doc(
          { "/a": { get: { responses: ok } } },
          { "x-shared": { Money: { type: "string" } } },
        ),
      },
      {
        name: "Billing",
        doc: doc(
          {
            "/b": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: { "application/json": { schema: { $ref: "#/x-shared/Money" } } },
                  },
                },
              },
            },
          },
          { "x-shared": { Money: { type: "integer" } } },
        ),
      },
    ]).doc;
    expect(JSON.stringify((merged.paths as JsonObject)["/b"])).toContain('"type":"integer"');
    expect((merged["x-shared"] as { Money: unknown }).Money).toEqual({ type: "string" });
    expectSelfContained(merged);
  });
});

describe("a family of schemas", () => {
  const family = doc(
    { "/pets": { get: { responses: returning("Pet") } } },
    {
      components: {
        schemas: {
          Pet: { type: "object", discriminator: { propertyName: "kind" } },
          Cat: { allOf: [{ $ref: "#/components/schemas/Pet" }] },
          Kitten: { allOf: [{ $ref: "#/components/schemas/Cat" }] },
          Stranger: { type: "object" },
        },
      },
    },
  );

  it("includes the schemas that extend its members", () => {
    expect(schemasOf(applyVariant(family, everything).doc)).toEqual(["Pet", "Cat", "Kitten"]);
  });

  it("changes for whoever receives it when a distant member changes", () => {
    const changed = structuredClone(family);
    ((changed.components as JsonObject).schemas as JsonObject).Kitten = {
      allOf: [{ $ref: "#/components/schemas/Cat" }],
      description: "Small.",
    };
    expect(fingerprintOperations(changed).get("GET /pets")).not.toBe(
      fingerprintOperations(family).get("GET /pets"),
    );
  });
});

describe("names that an object already has a meaning for", () => {
  it("are names like any other: a group of components called toString", () => {
    const odd = doc(
      { "/a": { get: { responses: ok, security: [{ valueOf: [] }] } } },
      {
        components: {
          toString: { Thing: { type: "string" } },
          securitySchemes: {
            valueOf: { type: "mutualTLS" },
            constructor: { type: "http", scheme: "bearer" },
          },
          schemas: { hasOwnProperty: { type: "object", toString: 1, const: 2 } },
        },
      },
    );
    const built = buildVariant(odd, { selection: everything, version: "3.0" });
    const components = built.doc.components as JsonObject;
    expect(components.toString).toEqual({ Thing: { type: "string" } });
    // The mutual TLS scheme is gone, and with it the requirement that named it.
    expect(JSON.stringify(built.doc.paths)).not.toContain("valueOf");
    expect(built.losses.map((loss) => loss.what)).toEqual(["mutual TLS security schemes"]);
  });
});

describe("YAML anchors", () => {
  const read = (lines: string[]) =>
    parseSpec(
      ["openapi: 3.1.0", 'info: { title: t, version: "1" }', "paths: {}", ...lines].join("\n"),
    ).doc;
  const refused = (lines: string[]) => {
    try {
      read(lines);
    } catch (error) {
      if (error instanceof SpecParseError) return error.message;
      throw error;
    }
    return "accepted";
  };

  it("on a key, and used as a key", () => {
    expect(read(["x-a: { &k name: 1 }", "x-b: *k", "x-c: { *k : 2 }"])).toMatchObject({
      "x-a": { name: 1 },
      "x-b": "name",
      "x-c": { name: 2 },
    });
    expect(refused(["x-a: { *nowhere : 1 }"])).toContain("no anchor before it");
  });

  it("mean the nearest one before the alias", () => {
    expect(read(["x-a: &x { v: &x 1, w: *x }", "x-b: *x"])).toMatchObject({
      "x-a": { v: 1, w: 1 },
      "x-b": 1,
    });
  });

  it("cannot be used inside the value they are on", () => {
    expect(refused(["x-w: &a first", "x-x: &a [1, *a]"])).toContain("the value it is inside of");
  });

  it("a document that starts with a brace may be YAML", () => {
    expect(parseSpec("{openapi: 3.1.0, info: {title: t, version: '1'}, paths: {}}").format).toBe(
      "yaml",
    );
  });
});
