import { describe, expect, it } from "vitest";
import {
  assembleDocument,
  buildVariant,
  fingerprintOperations,
  type JsonObject,
  normalizePathPrefix,
  type OpenAPIDocument,
  parseSpec,
  SpecParseError,
  serialize,
} from "../src/index.js";

/**
 * Documents built to cost as much as possible. A size limit in bytes does not
 * bound work: these are all small, and each once took many seconds, or the
 * whole stack. What is asserted is that they are either turned away at once
 * or handled in time that grows with their size, not with its square.
 */

const ok = { "200": { description: "ok" } };
const HEAD = '"openapi":"3.1.0","info":{"title":"t","version":"1"}';
const everything = { mode: "exclude" as const, operations: [], tags: [] };

/** How long `work` takes, in seconds. */
function seconds(work: () => unknown): number {
  const started = performance.now();
  work();
  return (performance.now() - started) / 1000;
}

function refusal(text: string): SpecParseError {
  try {
    parseSpec(text);
  } catch (error) {
    if (error instanceof SpecParseError) return error;
    throw error;
  }
  throw new Error("The document was accepted.");
}

describe("more structure than a document may have", () => {
  it("is refused when it is nested deeper than anything walks safely", () => {
    const nested = (levels: number) =>
      `{${HEAD},"paths":{},"x-deep":${"[".repeat(levels)}${"]".repeat(levels)}}`;
    expect(refusal(nested(50_000))).toMatchObject({ code: "too-complex" });
    expect(refusal(nested(250)).message).toContain("200 levels");

    // Just inside the limit, everything that walks a document copes with it.
    const { doc } = parseSpec(nested(190));
    doc.paths = { "/a": { get: { responses: ok, "x-deep": doc["x-deep"] } } };
    expect(fingerprintOperations(doc).size).toBe(1);
    const built = buildVariant(doc, { selection: everything, version: "3.0" });
    expect(serialize(built.doc, "json")).toContain("x-deep");
    expect(serialize(built.doc, "yaml")).toContain("x-deep");
  });

  it("is refused when it has more objects and lists than can be worked on", () => {
    const crowded = `{${HEAD},"paths":{},"x-many":[${"[],".repeat(1_100_000)}[]]}`;
    let error: SpecParseError | undefined;
    const took = seconds(() => {
      error = refusal(crowded);
    });
    expect(error).toMatchObject({ code: "too-complex" });
    expect(took).toBeLessThan(5);
  }, 30_000);

  it("is refused when YAML aliases make a small file into a large document", () => {
    // Every alias is looked up among all the others: 80,000 of them took a minute and a half.
    const names = Array.from({ length: 100 }, (_, n) => n);
    const yaml = [
      'openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths: {}',
      `x-anchors: [${names.map((n) => `&a${n} 1`).join(", ")}]`,
      "x-lists:",
      ...Array.from({ length: 800 }, () => `  - [${names.map((n) => `*a${n}`).join(", ")}]`),
    ].join("\n");
    let error: SpecParseError | undefined;
    const took = seconds(() => {
      error = refusal(yaml);
    });
    expect(error).toMatchObject({ code: "too-complex" });
    expect(error?.message).toContain("80,000 YAML aliases");
    expect(took).toBeLessThan(5);
  }, 30_000);

  it("still reads YAML that uses anchors the way people and generators do", () => {
    // PyYAML writes `&id001` and `*id001` when one object is used twice.
    const { doc } = parseSpec(
      [
        "openapi: 3.1.0",
        'info: { title: t, version: "1" }',
        "paths:",
        "  /a:",
        "    get:",
        "      responses: &id001",
        "        '200': { description: ok }",
        "  /b:",
        "    get:",
        "      responses: *id001",
        "x-defaults: &defaults { retries: 3 }",
        "x-service: { <<: *defaults, name: billing }",
      ].join("\n"),
    );
    const paths = doc.paths as Record<string, { get: { responses: unknown } }>;
    expect(paths["/b"]?.get.responses).toEqual({ "200": { description: "ok" } });
  });
});

describe("work that grows with the size of a document, not its square", () => {
  it("copies what many references into a hidden operation pointed at", () => {
    // 20,000 references into an operation the variant does not serve took 18 seconds.
    const count = 20_000;
    const gone: JsonObject = {};
    const kept: JsonObject = {};
    for (let n = 0; n < count; n++) {
      gone[`p${n}`] = { type: "string" };
      kept[`p${n}`] = { $ref: `#/paths/~1gone/get/x-shapes/p${n}` };
    }
    const doc: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/gone": { get: { responses: ok, "x-shapes": gone } },
        "/kept": { get: { responses: ok, "x-shapes": kept } },
      },
    };
    let served: OpenAPIDocument = doc;
    const took = seconds(() => {
      served = buildVariant(doc, {
        selection: { mode: "include", operations: ["GET /kept"], tags: [] },
      }).doc;
    });
    const shapes = ((served.paths as JsonObject)["/kept"] as { get: JsonObject }).get[
      "x-shapes"
    ] as JsonObject;
    expect(shapes.p0).toEqual({ type: "string" });
    expect(shapes[`p${count - 1}`]).toEqual({ type: "string" });
    expect(took).toBeLessThan(5);
  }, 30_000);

  it("renames thousands of components that two documents use differently", () => {
    // 20,000 colliding names took nine seconds; 40,000 tag groups took seven.
    const count = 20_000;
    const part = (type: string): OpenAPIDocument => ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { [`/${type}`]: { get: { responses: ok } } },
      components: {
        schemas: Object.fromEntries(Array.from({ length: count }, (_, n) => [`S${n}`, { type }])),
      },
      "x-tagGroups": Array.from({ length: count * 2 }, (_, n) => ({
        name: `Group ${n}`,
        tags: [type],
      })),
    });
    let merged: OpenAPIDocument = part("string");
    const took = seconds(() => {
      merged = assembleDocument([
        { name: "Core", doc: part("string") },
        { name: "Billing", doc: part("integer") },
      ]).doc;
    });
    const schemas = (merged.components as { schemas: JsonObject }).schemas;
    expect(Object.keys(schemas)).toHaveLength(count * 2);
    expect(schemas[`BillingS${count - 1}`]).toEqual({ type: "integer" });
    const groups = merged["x-tagGroups"] as Array<{ name: string; tags: string[] }>;
    expect(groups).toHaveLength(count * 2);
    expect(groups[0]).toEqual({ name: "Group 0", tags: ["string", "integer"] });
    expect(took).toBeLessThan(5);
  }, 30_000);

  it("fingerprints operations whose schemas form a long chain", () => {
    const count = 3_000;
    const doc: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: Object.fromEntries(
        Array.from({ length: count }, (_, n) => [
          `/op${n}`,
          {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: { $ref: `#/components/schemas/S${n}` } },
                  },
                },
              },
            },
          },
        ]),
      ),
      components: {
        schemas: Object.fromEntries(
          Array.from({ length: count }, (_, n) => [
            `S${n}`,
            n + 1 < count
              ? { type: "object", properties: { next: { $ref: `#/components/schemas/S${n + 1}` } } }
              : { type: "string" },
          ]),
        ),
      },
    };
    let fingerprints: Map<string, string> | undefined;
    const took = seconds(() => {
      fingerprints = fingerprintOperations(doc);
    });
    expect(fingerprints?.size).toBe(count);
    console.log(`fingerprinting ${count} chained operations took ${took.toFixed(2)} s`);
    expect(took).toBeLessThan(10);
  }, 60_000);

  it("trims a path prefix made of slashes", () => {
    const took = seconds(() => {
      expect(normalizePathPrefix(`${"/".repeat(200_000)}a`)).toMatch(/^\/+a$/);
      expect(normalizePathPrefix(`billing${"/".repeat(200_000)}`)).toBe("/billing");
    });
    expect(took).toBeLessThan(1);
  });
});
