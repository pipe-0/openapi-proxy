import { upgrade as scalarUpgrade, validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import {
  assembleDocument,
  availableVersions,
  buildVariant,
  ConvertError,
  convertDocument,
  indexOperations,
  type JsonObject,
  type OpenAPIDocument,
  type TargetVersion,
} from "../src/index.js";
import { expectSelfContained, loadFixture } from "./helpers.js";

/** A document whose only interesting part is one schema. */
const around = (openapi: string, schema: unknown): OpenAPIDocument => ({
  openapi,
  info: { title: "t", version: "1" },
  paths: {},
  components: { schemas: { Subject: schema } },
});
const subject = (doc: OpenAPIDocument) =>
  ((doc.components as JsonObject).schemas as JsonObject).Subject as JsonObject;

/** Convert one schema and return it, with what was reported lost. */
function convertSchema(from: string, to: TargetVersion, schema: unknown) {
  const { doc, losses } = convertDocument(around(from, schema), to);
  return { schema: subject(doc), losses: losses.map((loss) => loss.what) };
}
const up = (schema: unknown) => convertSchema("3.0.3", "3.1", schema).schema;
const down = (schema: unknown) => convertSchema("3.1.0", "3.0", schema).schema;

describe("3.0 to 3.1", () => {
  it.each([
    ["nullable with a type", { type: "string", nullable: true }, { type: ["string", "null"] }],
    ["nullable: false", { type: "string", nullable: false }, { type: "string" }],
    [
      "a nullable reference",
      { nullable: true, allOf: [{ $ref: "#/components/schemas/Other" }], description: "d" },
      {
        description: "d",
        anyOf: [{ allOf: [{ $ref: "#/components/schemas/Other" }] }, { type: "null" }],
      },
    ],
    [
      "an exclusive minimum",
      { type: "integer", minimum: 5, exclusiveMinimum: true },
      { type: "integer", exclusiveMinimum: 5 },
    ],
    [
      "a bound that is not exclusive",
      { type: "integer", maximum: 9, exclusiveMaximum: false },
      { type: "integer", maximum: 9 },
    ],
    ["an example", { type: "string", example: "a" }, { type: "string", examples: ["a"] }],
    // Still understood by 3.1 tools, so left alone.
    ["a file", { type: "string", format: "binary" }, { type: "string", format: "binary" }],
  ])("%s", (_name, before, after) => {
    expect(up(before)).toEqual(after);
  });

  it("keeps the order of keywords", () => {
    expect(
      Object.keys(
        up({ description: "d", type: "integer", minimum: 1, exclusiveMinimum: true, title: "t" }),
      ),
    ).toEqual(["description", "type", "exclusiveMinimum", "title"]);
  });

  it("loses nothing, and says so", () => {
    expect(convertDocument(loadFixture("petstore-3.0.yaml"), "3.1").losses).toEqual([]);
  });
});

describe("3.1 to 3.0", () => {
  it.each([
    ["a type or null", { type: ["string", "null"] }, { type: "string", nullable: true }],
    ["only null", { type: "null" }, { enum: [null], nullable: true }],
    [
      "several types",
      { type: ["string", "integer", "null"], description: "d" },
      { anyOf: [{ type: "string" }, { type: "integer" }], nullable: true, description: "d" },
    ],
    ["a constant", { const: "fixed" }, { enum: ["fixed"] }],
    [
      "a reference or null",
      { anyOf: [{ $ref: "#/components/schemas/Other" }, { type: "null" }] },
      { allOf: [{ $ref: "#/components/schemas/Other" }], nullable: true },
    ],
    [
      "a plain schema or null",
      { description: "when", anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
      { description: "when", type: "string", format: "date", nullable: true },
    ],
    [
      "a reference with siblings",
      { $ref: "#/components/schemas/Other", description: "d" },
      { allOf: [{ $ref: "#/components/schemas/Other" }], description: "d" },
    ],
    [
      "an exclusive minimum",
      { type: "integer", exclusiveMinimum: 5 },
      { type: "integer", minimum: 5, exclusiveMinimum: true },
    ],
    ["examples", { type: "string", examples: ["a"] }, { type: "string", example: "a" }],
    [
      "a file",
      { type: "string", contentMediaType: "application/octet-stream" },
      { type: "string", format: "binary" },
    ],
    ["base64", { type: "string", contentEncoding: "base64" }, { type: "string", format: "byte" }],
    ["an array of anything", { type: "array" }, { type: "array", items: {} }],
    [
      "schemas that are true or false",
      { type: "object", properties: { any: true, none: false }, additionalProperties: false },
      { type: "object", properties: { any: {}, none: { not: {} } }, additionalProperties: false },
    ],
  ])("%s", (_name, before, after) => {
    expect(down(before)).toEqual(after);
  });

  it("removes what 3.0 has no word for, and says what", () => {
    const { schema, losses } = convertSchema("3.1.0", "3.0", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      patternProperties: { "^x-": { type: "string" } },
      if: { required: ["a"] },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword under test
      then: { required: ["b"] },
      examples: ["one", "two"],
      properties: { tuple: { type: "array", prefixItems: [{ type: "string" }] } },
    });
    expect(schema).toEqual({
      type: "object",
      example: "one",
      properties: { tuple: { type: "array", items: {} } },
    });
    expect(losses.sort()).toEqual([
      "all but the first example of a schema",
      "conditions (if, then, else)",
      "properties matched by pattern (patternProperties)",
      "tuples (prefixItems)",
    ]);
  });

  it("moves webhooks to x-webhooks, inlines path items, and tidies the top of the document", () => {
    const { doc, losses } = convertDocument(
      {
        openapi: "3.1.0",
        info: {
          title: "t",
          version: "1",
          summary: "Short",
          license: { name: "MIT", identifier: "MIT" },
        },
        jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
        paths: { "/a": { $ref: "#/components/pathItems/A" } },
        webhooks: { created: { post: { responses: { "200": { description: "ok" } } } } },
        components: {
          pathItems: {
            A: {
              get: {
                parameters: [{ name: "q", in: "query", schema: { type: ["string", "null"] } }],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      },
      "3.0",
    );
    expect(doc).toEqual({
      openapi: "3.0.3",
      info: { title: "t", version: "1", license: { name: "MIT" }, description: "Short" },
      paths: {
        "/a": {
          get: {
            parameters: [{ name: "q", in: "query", schema: { type: "string", nullable: true } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      "x-webhooks": { created: { post: { responses: { "200": { description: "ok" } } } } },
    });
    expect(losses.map((loss) => loss.what)).toEqual([
      "webhooks as a standard section (they are kept under x-webhooks)",
    ]);
  });
});

describe("what counts as a schema", () => {
  it("is decided by where it stands, not by what it looks like", () => {
    const { doc } = convertDocument(
      {
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: {
          "/things": {
            get: {
              parameters: [
                { name: "limit", in: "query", schema: { type: "integer", nullable: true } },
              ],
              responses: {
                "200": {
                  description: "ok",
                  headers: { "X-Next": { schema: { type: "string", nullable: true } } },
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Thing" },
                      // Data, not a schema: stays exactly as written.
                      example: { nullable: true, example: "untouched" },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Thing: {
              type: "object",
              // Properties that happen to be named like keywords.
              properties: {
                nullable: { type: "boolean" },
                example: { type: "string", nullable: true },
              },
              default: { nullable: true },
            },
          },
        },
      },
      "3.1",
    );
    const get = ((doc.paths as JsonObject)["/things"] as JsonObject).get as JsonObject;
    expect(get.parameters).toEqual([
      { name: "limit", in: "query", schema: { type: ["integer", "null"] } },
    ]);
    const response = (get.responses as JsonObject)["200"] as JsonObject;
    expect(response.headers).toEqual({ "X-Next": { schema: { type: ["string", "null"] } } });
    expect((response.content as JsonObject)["application/json"]).toMatchObject({
      example: { nullable: true, example: "untouched" },
    });
    expect(((doc.components as JsonObject).schemas as JsonObject).Thing).toEqual({
      type: "object",
      properties: { nullable: { type: "boolean" }, example: { type: ["string", "null"] } },
      default: { nullable: true },
    });
  });
});

describe("whole documents", () => {
  const errorsOf = async (doc: OpenAPIDocument) =>
    (await validate(JSON.stringify(doc))).errors ?? [];

  it("there and back again gives the same document", () => {
    const original = loadFixture("petstore-3.0.yaml");
    const there = convertDocument(original, "3.1").doc;
    expect(there.openapi).toBe("3.1.0");
    const back = convertDocument(there, "3.0").doc;
    expect(back).toEqual({ ...original, openapi: "3.0.3" });
  });

  it("does not touch a document that is already in the version asked for", () => {
    const doc = loadFixture("pipe0.json");
    expect(convertDocument(doc, "3.1").doc).toBe(doc);
  });

  it.each(["petstore-3.0.yaml", "discriminator.json"])(
    "%s is valid 3.1 after the upgrade",
    async (name) => {
      const { doc } = convertDocument(loadFixture(name), "3.1");
      expect(await errorsOf(doc)).toEqual([]);
      expectSelfContained(doc);
    },
  );

  it.each(["pipe0.json", "cycles.json", "webhooks.json", "security-schemes.json"])(
    "%s is valid 3.0 after the downgrade",
    async (name) => {
      const original = loadFixture(name);
      const { doc } = convertDocument(original, "3.0");
      expect(doc.openapi).toBe("3.0.3");
      expect(await errorsOf(doc)).toEqual([]);
      expectSelfContained(doc);
      // Converting describes the same API: no operation appears or disappears.
      const paths = (candidate: OpenAPIDocument) =>
        indexOperations(candidate)
          .entries.filter((entry) => !entry.webhook)
          .map((entry) => entry.key);
      expect(paths(doc)).toEqual(paths(original));
    },
  );

  it("agrees with another implementation on what an upgraded schema means", () => {
    // The validator's own upgrader is the second opinion.
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", nullable: true },
        age: { type: "integer", minimum: 0, exclusiveMinimum: true },
      },
    };
    const ours = subject(convertDocument(around("3.0.3", schema), "3.1").doc);
    const theirs = scalarUpgrade(around("3.0.3", structuredClone(schema)) as never)
      .specification as OpenAPIDocument;
    expect(ours.properties).toEqual(subject(theirs).properties);
  });

  it("says which versions a document can be served as", () => {
    expect(availableVersions(around("3.0.3", {}))).toEqual(["3.0", "3.1"]);
    expect(availableVersions(around("3.1.0", {}))).toEqual(["3.0", "3.1"]);
    expect(availableVersions(around("3.2.0", {}))).toEqual([]);
    expect(() => convertDocument(around("3.2.0", {}), "3.0")).toThrow(ConvertError);
  });
});

describe("the pipeline", () => {
  const ok = { "200": { description: "ok" } };
  const old: OpenAPIDocument = {
    openapi: "3.0.3",
    info: { title: "Legacy", version: "1" },
    paths: {
      "/legacy": {
        get: {
          responses: ok,
          parameters: [{ name: "q", in: "query", schema: { type: "string", nullable: true } }],
        },
      },
    },
  };
  const current: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "Main", version: "1" },
    paths: { "/main": { get: { responses: ok } } },
  };

  it("brings a 3.0 source to 3.1 so it can be merged with newer ones, and says so", () => {
    const assembled = assembleDocument([
      { name: "Main", doc: current },
      { name: "Legacy", doc: old },
    ]);
    expect(assembled.doc.openapi).toBe("3.1.0");
    expect(assembled.converted).toEqual([{ source: "Legacy", from: "3.0", to: "3.1" }]);
    const legacy = ((assembled.doc.paths as JsonObject)["/legacy"] as JsonObject).get as JsonObject;
    expect(legacy.parameters).toEqual([
      { name: "q", in: "query", schema: { type: ["string", "null"] } },
    ]);
    // The source itself is not changed.
    expect(JSON.stringify(old)).toContain('"nullable":true');
  });

  it("converts nothing when the sources agree", () => {
    const assembled = assembleDocument([{ name: "Main", doc: current }]);
    expect(assembled.doc).toBe(current);
    expect(assembled.converted).toEqual([]);
  });

  it("serves a variant as its document is when that can no longer be converted", () => {
    const newer: OpenAPIDocument = { ...current, openapi: "3.2.0" };
    const built = buildVariant(newer, {
      selection: {},
      version: "3.0",
    });
    expect(built.doc.openapi).toBe("3.2.0");
    expect(built.losses).toHaveLength(1);
    expect(built.losses[0]?.what).toContain("cannot be converted to 3.0 yet");
  });

  it("serves a variant in the version it asks for, converting only what is served", () => {
    const doc = loadFixture("webhooks.json");
    const [first] = indexOperations(doc).entries.filter((entry) => !entry.webhook);
    const selection = { include: { operations: [first?.key as string] } };

    const asIs = buildVariant(doc, { selection });
    expect(asIs.doc.openapi).toBe("3.1.0");
    expect(asIs.losses).toEqual([]);

    const older = buildVariant(doc, { selection, version: "3.0" });
    expect(older.doc.openapi).toBe("3.0.3");
    expect(older.stats).toEqual(asIs.stats);
    // The webhooks were not selected, so there is nothing to report about them.
    expect(older.losses).toEqual([]);
  });
});
