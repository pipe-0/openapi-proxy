import { describe, expect, it } from "vitest";
import { budgetLeft } from "../src/document/budget.js";
import {
  assembleDocument,
  buildVariant,
  DocumentTooComplexError,
  fingerprintOperations,
  indexOperations,
  type JsonObject,
  type MergePart,
  measure,
  normalizePathPrefix,
  type OpenAPIDocument,
  OUTPUT_LIMITS,
  parseSpec,
  type Selection,
  SpecParseError,
  serialize,
  WORK_BUDGET,
  withBudget,
} from "../src/index.js";
import { loadFixtureText } from "./helpers.js";

/**
 * Documents built to cost as much as possible. A size limit in bytes bounds
 * none of them: each is small, and each once took many seconds, hundreds of
 * megabytes, or the whole stack.
 *
 * Two things hold against all of them, and neither is a special case per
 * document. What a document holds is measured as it would be written out
 * (document/limits.ts), and the work done on it is counted (document/budget.ts).
 * So every document here is either handled, in an amount of work that the
 * budget bounds, or turned away with a reason.
 */

const ok = { "200": { description: "ok" } };
const HEAD = '"openapi":"3.1.0","info":{"title":"t","version":"1"}';
const YAML_HEAD = 'openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths: {}';
const everything: Selection = { mode: "exclude", operations: [], tags: [] };
const only = (...operations: string[]): Selection => ({ mode: "include", operations, tags: [] });
const count = <T>(length: number, each: (n: number) => T): T[] =>
  Array.from({ length }, (_, n) => each(n));
const doc = (paths: JsonObject, extra: JsonObject = {}): OpenAPIDocument => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths,
  ...extra,
});

function refusal(text: string): SpecParseError {
  try {
    parseSpec(text);
  } catch (error) {
    if (error instanceof SpecParseError) return error;
    throw error;
  }
  throw new Error("The document was accepted.");
}

describe("what a document may hold", () => {
  it("is nested no deeper than anything walks safely", () => {
    const nested = (levels: number) =>
      `{${HEAD},"paths":{},"x-deep":${"[".repeat(levels)}${"]".repeat(levels)}}`;
    expect(refusal(nested(50_000))).toMatchObject({ code: "too-complex" });
    expect(refusal(nested(250)).message).toContain("200 levels");

    // Just inside the limit, everything that walks a document copes with it.
    const { doc: deep } = parseSpec(nested(190));
    deep.paths = { "/a": { get: { responses: ok, "x-deep": deep["x-deep"] } } };
    expect(fingerprintOperations(deep).size).toBe(1);
    const built = buildVariant(deep, { selection: everything, version: "3.0" });
    expect(serialize(built.doc, "json")).toContain("x-deep");
    expect(serialize(built.doc, "yaml")).toContain("x-deep");
  });

  it("is measured as it would be written out, so a file cannot stand for a far larger one", () => {
    // 4,900 mentions of one 100 kB text: half a megabyte of file, half a gigabyte written out.
    const repeated = [
      YAML_HEAD,
      `x-text: &text "${"x".repeat(100_000)}"`,
      `x-again: [${count(4_900, () => "*text").join(", ")}]`,
    ].join("\n");
    expect(refusal(repeated)).toMatchObject({
      code: "too-complex",
      message: expect.stringContaining("more than 30 MB when it is written out"),
    });

    // Indentation counts: a thousand chains nearly a hundred levels deep are
    // half a megabyte of JSON on one line, and twenty when it is indented.
    const chain = `${'{"a":'.repeat(95)}0${"}".repeat(95)}`;
    const chains = (n: number) =>
      `{${HEAD},"paths":{"/a":{"get":{"responses":{},"x-deep":[${count(n, () => chain).join(",")}]}}}}`;
    expect(refusal(chains(8_000)).message).toContain("more than 30 MB");
    // What is accepted is served at no more than it was measured at, in either format.
    const built = buildVariant(parseSpec(chains(1_000)).doc, { selection: everything });
    const measured = measure(built.doc, OUTPUT_LIMITS);
    for (const format of ["json", "yaml"] as const) {
      expect(serialize(built.doc, format).length).toBeLessThanOrEqual(measured);
    }

    // Many small things are fine: over a million lists in three megabytes.
    const crowded = `{${HEAD},"paths":{},"x-many":[${"[],".repeat(1_100_000)}[]]}`;
    expect(parseSpec(crowded).doc["x-many"]).toHaveLength(1_100_001);
  }, 60_000);

  it("is plain data: YAML is read as JSON with another syntax", () => {
    // YAML 1.1 merge keys, sets and dates give values no JSON document has.
    const { doc: read } = parseSpec(
      [
        "%YAML 1.1",
        "---",
        YAML_HEAD,
        "x-base: &base { a: 1 }",
        "x-merged: { <<: *base }",
        "x-when: 2001-12-14t21:59:43.10-05:00",
        "x-set: !!set { a, b }",
        "x-codes: { 200: ok, true: yes, ~: none }",
        "x-twice: { a: 1, a: 2 }",
      ].join("\n"),
    );
    expect(read["x-merged"]).toEqual({ "<<": { a: 1 } });
    expect(read["x-when"]).toBe("2001-12-14t21:59:43.10-05:00");
    expect(Object.getPrototypeOf(read["x-set"])).toBe(Object.prototype);
    // Keys are text, as a status code is. One written twice counts once, the later value.
    expect(read["x-codes"]).toEqual({ "200": "ok", true: "yes", "": "none" });
    expect(read["x-twice"]).toEqual({ a: 2 });
    // A list or a map cannot be a key.
    expect(refusal(`${YAML_HEAD}\nx-keys: { []: 0 }`).message).toContain("Keys have to be text");
  });

  it("reads anchors and aliases the way people and generators write them", () => {
    // PyYAML writes `&id001` and `*id001` when one object is used twice.
    const { doc: read } = parseSpec(
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
      ].join("\n"),
    );
    const paths = read.paths as Record<string, { get: { responses: unknown } }>;
    expect(paths["/b"]?.get.responses).toEqual({ "200": { description: "ok" } });
    expect(refusal(`${YAML_HEAD}\nx-a: *nowhere`).message).toContain("no anchor before it");
  });
});

describe("the work a document may cause", () => {
  /** The steps `work` takes, counted the way the budget counts them. */
  const stepsOf = (work: () => unknown) =>
    withBudget(() => {
      const before = budgetLeft() as number;
      work();
      return before - (budgetLeft() as number);
    });

  it("is a small part of the budget for a real document", () => {
    const text = loadFixtureText("pipe0.json");
    const { doc: real } = parseSpec(text);
    // The most expensive thing the service does: merging 800 kB with as much again.
    const merging = stepsOf(() =>
      assembleDocument([
        { name: "Core", doc: real },
        { name: "Again", doc: real, pathPrefix: "/v2" },
      ]),
    );
    const connecting = stepsOf(() => {
      indexOperations(real);
      fingerprintOperations(real);
    });
    const rendering = stepsOf(() =>
      serialize(buildVariant(real, { selection: everything, version: "3.0" }).doc, "yaml"),
    );
    for (const steps of [merging, connecting, rendering]) {
      expect(steps).toBeGreaterThan(10_000); // it is being counted
      expect(steps).toBeLessThan(WORK_BUDGET / 20);
    }
  });

  /**
   * Everything the service does with a document, start to finish: read it,
   * index and fingerprint it, merge it with another if there is one, cut a
   * variant from it and write that out.
   */
  function life(source: string | OpenAPIDocument, selection: Selection, second?: MergePart) {
    const first = typeof source === "string" ? parseSpec(source).doc : source;
    indexOperations(first);
    fingerprintOperations(first);
    const whole = second ? assembleDocument([{ name: "Core", doc: first }, second]).doc : first;
    const built = buildVariant(whole, { selection, version: "3.0" });
    return {
      json: serialize(built.doc, "json", { minified: true }),
      yaml: serialize(built.doc, "yaml"),
    };
  }

  const chained = (length: number, leaf: JsonObject = { type: "string" }) =>
    doc(
      Object.fromEntries(
        count(length, (n) => [
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
      {
        components: {
          schemas: Object.fromEntries(
            count(length, (n) => [
              `S${n}`,
              n + 1 < length
                ? {
                    type: "object",
                    properties: { next: { $ref: `#/components/schemas/S${n + 1}` } },
                  }
                : leaf,
            ]),
          ),
        },
      },
    );

  /**
   * Shapes a real document can have, at sizes no real document reaches. Work
   * on these has to grow with their size, so each fits the budget.
   */
  const handled: Array<[string, () => unknown]> = [
    ["5,000 operations over a chain of 5,000 schemas", () => life(chained(5_000), everything)],
    [
      "5,000 schemas that two documents name alike and mean differently",
      () => {
        const merged = assembleDocument([
          { name: "Core", doc: chained(2_500) },
          { name: "Billing", doc: chained(2_500, { type: "integer" }), pathPrefix: "/billing" },
        ]).doc;
        // One difference at the end of the chain makes every schema before it mean something else.
        expect(Object.keys((merged.components as { schemas: object }).schemas)).toHaveLength(5_000);
      },
    ],
    [
      "10,000 references into an operation that is not served",
      () => {
        const gone = Object.fromEntries(count(10_000, (n) => [`p${n}`, { type: "string" }]));
        const kept = Object.fromEntries(
          count(10_000, (n) => [`p${n}`, { $ref: `#/paths/~1gone/get/x-shapes/p${n}` }]),
        );
        const served = life(
          doc({
            "/gone": { get: { responses: ok, "x-shapes": gone } },
            "/kept": { get: { responses: ok, "x-shapes": kept } },
          }),
          only("GET /kept"),
        );
        expect(served.json.match(/"type":"string"/g)).toHaveLength(10_000);
      },
    ],
    [
      "a family of 20,000 schemas found through allOf",
      () => {
        const schemas: JsonObject = {
          Pet: { type: "object", discriminator: { propertyName: "kind" } },
        };
        for (let n = 0; n < 20_000; n++)
          schemas[`Pet${n}`] = { allOf: [{ $ref: "#/components/schemas/Pet" }] };
        const served = life(
          doc(
            {
              "/pets": {
                get: {
                  responses: {
                    "200": {
                      description: "ok",
                      content: {
                        "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
                      },
                    },
                  },
                },
              },
            },
            { components: { schemas } },
          ),
          everything,
        );
        expect(served.json).toContain('"Pet19999"');
      },
    ],
    [
      "YAML with 100,000 anchors and 50,000 aliases",
      () => {
        const { doc: read } = parseSpec(
          [
            YAML_HEAD,
            `x-anchors: [${count(100_000, (n) => `&a${n} 1`).join(", ")}]`,
            `x-aliases: [${count(50_000, (n) => `*a${n}`).join(", ")}]`,
          ].join("\n"),
        );
        expect(read["x-aliases"]).toHaveLength(50_000);
      },
    ],
    [
      "4,000 operations that each inherit 4,000 security requirements",
      () =>
        life(
          doc(Object.fromEntries(count(4_000, (n) => [`/p${n}`, { get: { responses: ok } }])), {
            security: count(4_000, (n) => ({ [`scheme${n}`]: [] })),
          }),
          everything,
        ),
    ],
    [
      "a YAML map with 100,000 keys",
      () => {
        const { doc: read } = parseSpec(
          `${YAML_HEAD}\nx-wide:\n${count(100_000, (n) => `  k${n}: 0`).join("\n")}\n`,
        );
        expect(Object.keys(read["x-wide"] as object)).toHaveLength(100_000);
      },
    ],
  ];

  it.each(handled)(
    "grows with the size of the document: %s",
    (_shape, work) => {
      expect(stepsOf(work)).toBeLessThan(WORK_BUDGET);
    },
    60_000,
  );

  /**
   * Shapes nobody writes by accident: each multiplies something. They are
   * turned away, at the latest when the budget is spent, and say why.
   */
  const refusedShapes: Array<[string, () => unknown]> = [
    [
      "1,000 paths that share one path item of 10,000 fields",
      () => {
        const wide: JsonObject = { get: { responses: ok }, post: { responses: ok } };
        for (let n = 0; n < 10_000; n++) wide[`x-field-${n}`] = n;
        return life(
          doc(
            Object.fromEntries(
              count(1_000, (n) => [`/p${n}`, { $ref: "#/components/pathItems/Wide" }]),
            ),
            { components: { pathItems: { Wide: wide } } },
          ),
          only(...count(1_000, (n) => `GET /p${n}`)),
        );
      },
    ],
    [
      "references that chain, each copy nesting inside the last",
      () => {
        const deep = (end: JsonObject) => {
          let node = end;
          for (let level = 0; level < 150; level++) node = { level: node };
          return node;
        };
        const paths: JsonObject = {
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
        return life(doc(paths), only("GET /kept"));
      },
    ],
    [
      "3,000 references that each lead only to the next",
      () => {
        const hops = Object.fromEntries(
          count(3_000, (n) => [
            `h${n}`,
            n < 2_999 ? { $ref: `#/paths/~1gone/get/x-h/h${n + 1}` } : { end: true },
          ]),
        );
        return life(
          doc({
            "/gone": { get: { responses: ok, "x-h": hops } },
            "/kept": { get: { responses: ok, "x-uses": { $ref: "#/paths/~1gone/get/x-h/h0" } } },
          }),
          only("GET /kept"),
        );
      },
    ],
    [
      "3,000 replaced references under one key of 64,000 characters",
      () =>
        life(
          doc({
            "/gone": {
              get: {
                responses: ok,
                "x-t": Object.fromEntries(count(3_000, (n) => [`t${n}`, { n }])),
              },
            },
            "/kept": {
              get: {
                responses: ok,
                ["k".repeat(64_000)]: Object.fromEntries(
                  count(3_000, (n) => [`r${n}`, { $ref: `#/paths/~1gone/get/x-t/t${n}` }]),
                ),
              },
            },
          }),
          only("GET /kept"),
        ),
    ],
    [
      "one reference of 8,000 segments, mentioned 600 times",
      () => {
        const long = { $ref: `#/zz/${"a/".repeat(8_000)}a` };
        return life(
          doc({
            "/gone": { get: { responses: ok } },
            "/kept": {
              get: {
                responses: ok,
                // Something has to be replaced before a reference is looked up among the copies.
                "x-first": { $ref: "#/paths/~1gone/get/responses" },
                "x-uses": count(600, () => long),
              },
            },
          }),
          only("GET /kept"),
        );
      },
    ],
    [
      "YAML in which one large list is mentioned 5,000 times",
      () =>
        parseSpec(
          [
            YAML_HEAD,
            `x-big: &big [${"[], ".repeat(200_000)}[]]`,
            `x-again: [${count(5_000, () => "*big").join(", ")}]`,
          ].join("\n"),
        ),
    ],
  ];

  it.each(refusedShapes)(
    "turns away what multiplies: %s",
    (_shape, work) => {
      let error: unknown;
      const started = performance.now();
      try {
        work();
      } catch (thrown) {
        error = thrown;
      }
      // Refused for what it is, by the measure or by the budget: not a crash, and not a long wait.
      expect(error instanceof DocumentTooComplexError || error instanceof SpecParseError).toBe(
        true,
      );
      expect(performance.now() - started).toBeLessThan(15_000);
    },
    60_000,
  );

  it("starts every call with a full budget, whatever the last one did", () => {
    const exhausting = refusedShapes.find(([shape]) => shape.includes("one path item of 10,000"));
    expect(exhausting?.[1]).toThrow(DocumentTooComplexError);
    expect(fingerprintOperations(doc({ "/a": { get: { responses: ok } } })).size).toBe(1);
  });

  it("does not depend on a pattern that backtracks: a path prefix of 200,000 slashes", () => {
    expect(normalizePathPrefix(`billing${"/".repeat(200_000)}`)).toBe("/billing");
    expect(normalizePathPrefix(`${"/".repeat(200_000)}a`)).toMatch(/^\/+a$/);
  });
});
