import { describe, expect, it } from "vitest";
import {
  applyVariant,
  buildVariant,
  fingerprintOperations,
  type JsonObject,
  mergeDocuments,
  type OpenAPIDocument,
} from "../src/index.js";
import { expectSelfContained } from "./helpers.js";

/**
 * The ways a document refers to something, beyond `$ref` to a component with
 * a plain name. Each of these was once not seen as a reference by something:
 * by the pruning (which then removed what was referred to), by the comparison
 * of two documents' components, or by change detection.
 */

const returning = (schema: JsonObject) => ({
  "200": { description: "ok", content: { "application/json": { schema } } },
});
const doc = (paths: JsonObject, schemas: JsonObject = {}): OpenAPIDocument => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths,
  components: { schemas },
});
const schemasOf = (document: OpenAPIDocument) =>
  (document.components as { schemas?: Record<string, JsonObject> } | undefined)?.schemas ?? {};
const everything = {};
const changedBetween = (before: OpenAPIDocument, after: OpenAPIDocument) => {
  const [was, is] = [fingerprintOperations(before), fingerprintOperations(after)];
  return [...is.keys()].filter((key) => was.get(key) !== is.get(key));
};

describe("a component name written with percent escapes", () => {
  // Generators name generic types like this: Page«User».
  const withPage = (page: JsonObject) =>
    doc(
      {
        "/users": { get: { responses: returning({ $ref: "#/components/schemas/Wrapper" }) } },
      },
      {
        Wrapper: {
          type: "object",
          properties: { page: { $ref: "#/components/schemas/Page%C2%ABUser%C2%BB" } },
        },
        "Page«User»": page,
        Unused: { type: "string" },
      },
    );

  it("is kept by a variant that reaches it", () => {
    const served = applyVariant(withPage({ type: "string" }), everything).doc;
    expect(Object.keys(schemasOf(served))).toEqual(["Wrapper", "Page«User»"]);
    expectSelfContained(served);
  });

  it("counts when two documents are compared, and follows a rename", () => {
    const { doc: merged, notes } = mergeDocuments([
      { name: "Core", doc: withPage({ type: "string" }) },
      { name: "Billing", doc: withPage({ type: "integer" }), pathPrefix: "/billing" },
    ]);
    // The wrappers look alike and mean different things, because their pages do.
    expect(notes.map((note) => (note.kind === "component-renamed" ? note.to : note.kind))).toEqual([
      "BillingWrapper",
      "BillingPage«User»",
    ]);
    const schemas = schemasOf(merged);
    expect(schemas.BillingWrapper?.properties).toEqual({
      page: { $ref: "#/components/schemas/BillingPage%C2%ABUser%C2%BB" },
    });
    expect(schemas["BillingPage«User»"]).toEqual({ type: "integer" });
    expectSelfContained(merged);
  });

  it("makes a change to it a change to the operations that reach it", () => {
    expect(changedBetween(withPage({ type: "string" }), withPage({ type: "integer" }))).toEqual([
      "GET /users",
    ]);
  });
});

describe("a schema that a discriminator names without a reference", () => {
  const family = (cat: JsonObject) =>
    doc(
      { "/pets": { get: { responses: returning({ $ref: "#/components/schemas/Pet" }) } } },
      {
        Pet: {
          type: "object",
          discriminator: { propertyName: "kind", mapping: { cat: "Cat" }, defaultMapping: "Other" },
        },
        Cat: cat,
        Other: { type: "object" },
        Unused: { type: "string" },
      },
    );

  it("is kept, by its bare name in a mapping and as the default", () => {
    const served = applyVariant(family({ type: "object" }), everything).doc;
    expect(Object.keys(schemasOf(served))).toEqual(["Pet", "Cat", "Other"]);
  });

  it("makes a change to it a change to the operations that return the family", () => {
    const changed = changedBetween(
      family({ type: "object" }),
      family({ type: "object", required: ["lives"] }),
    );
    expect(changed).toEqual(["GET /pets"]);
  });
});

describe("a reference to where a schema was first written", () => {
  // Bundlers point later uses of a schema at its first occurrence.
  const bundled = (user: JsonObject) =>
    doc({
      "/users": { get: { responses: returning(user) } },
      "/report": {
        get: {
          responses: returning({
            $ref: "#/paths/~1users/get/responses/200/content/application~1json/schema",
          }),
        },
      },
    });
  const text = { type: "object", properties: { name: { type: "string" } } };
  const number = { type: "object", properties: { name: { type: "integer" } } };

  it("makes a change there a change to the operation that borrows it", () => {
    expect(changedBetween(bundled(text), bundled(number)).sort()).toEqual([
      "GET /report",
      "GET /users",
    ]);
  });

  it("counts when two documents are compared", () => {
    const using = (user: JsonObject) => {
      const base = bundled(user);
      (base.components as JsonObject).schemas = {
        Borrowed: { $ref: "#/paths/~1users/get/responses/200/content/application~1json/schema" },
      };
      return base;
    };
    const { notes } = mergeDocuments([
      { name: "Core", doc: using(text) },
      { name: "Billing", doc: using(number), pathPrefix: "/billing" },
    ]);
    // `Borrowed` is the same line in both and means a different schema in each.
    expect(notes).toContainEqual({
      kind: "component-renamed",
      source: "Billing",
      group: "schemas",
      from: "Borrowed",
      to: "BillingBorrowed",
    });
  });

  it("is replaced by a copy of the right thing when its keys contain a percent sign", () => {
    // `a%41b` is a key with a percent sign in it. `aAb` is another key.
    const tricky: OpenAPIDocument = doc({
      "/gone": {
        get: {
          responses: {},
          "x-shapes": { "a%41b": { which: "percent" }, aAb: { which: "plain" } },
        },
      },
      "/kept": {
        get: {
          responses: {},
          "x-uses": [
            { $ref: "#/paths/~1gone/get/x-shapes/a%2541b" },
            { $ref: "#/paths/~1gone/get/x-shapes/aAb" },
            // Spelled with an escape, this is the plain key again.
            { $ref: "#/paths/~1gone/get/x-shapes/a%41b" },
          ],
        },
      },
    });
    const built = buildVariant(tricky, {
      selection: { include: { operations: ["GET /kept"] } },
    }).doc;
    const uses = ((built.paths as JsonObject)["/kept"] as { get: JsonObject }).get[
      "x-uses"
    ] as JsonObject[];
    expect(uses[0]).toEqual({ which: "percent" });
    expect(uses[1]).toEqual({ which: "plain" });
    // The third is the second again, and points at its copy.
    expect(uses[2]).toEqual({ $ref: "#/paths/~1kept/get/x-uses/1" });
    expectSelfContained(built);
  });
});

describe("what a component means, compared with a plain way of working it out", () => {
  /**
   * The plain way: everything a component reaches, with what each of those
   * is, as one sorted text. Slow (it walks from every component separately),
   * and obviously right. The engine's digests have to say "same" and
   * "different" exactly where this does, within a document and across two.
   */
  function meanings(document: OpenAPIDocument): Map<string, string> {
    const schemas = schemasOf(document);
    const usesOf = (name: string) =>
      [...JSON.stringify(schemas[name] ?? null).matchAll(/#\/components\/schemas\/(\w+)/g)].map(
        (match) => match[1] as string,
      );
    const out = new Map<string, string>();
    for (const start of Object.keys(schemas)) {
      const reached = new Set<string>();
      const queue = [start];
      for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
        if (reached.has(name)) continue;
        reached.add(name);
        queue.push(...usesOf(name));
      }
      out.set(
        start,
        JSON.stringify([...reached].sort().map((name) => [name, schemas[name] ?? "missing"])),
      );
    }
    return out;
  }

  /** A small random number generator, so that a failure can be run again. */
  function random(seed: number) {
    let state = seed;
    return (below: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % below;
    };
  }

  /** Schemas that refer to each other at random: chains, rings, self-references, dangling ones. */
  function graph(next: (below: number) => number, size: number): Record<string, JsonObject> {
    const schemas: Record<string, JsonObject> = {};
    for (let n = 0; n < size; n++) {
      const properties: JsonObject = { kind: { const: next(3) } };
      for (let edge = next(3); edge > 0; edge--) {
        // Now and then a reference to a schema that does not exist.
        properties[`p${edge}`] = { $ref: `#/components/schemas/S${next(size + 1)}` };
      }
      schemas[`S${n}`] = { type: "object", properties };
    }
    return schemas;
  }

  it("agrees on which components of one document mean the same, and on what a change reaches", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const schemas = graph(next, 2 + next(12));
      const names = Object.keys(schemas);
      // An operation per schema, so that the fingerprints are the digests under test.
      const operations = (all: Record<string, JsonObject>) =>
        doc(
          Object.fromEntries(
            names.map((name) => [
              `/${name}`,
              { get: { responses: returning({ $ref: `#/components/schemas/${name}` }) } },
            ]),
          ),
          all,
        );

      // Change one schema: exactly the operations that reach it are different afterwards.
      const target = names[next(names.length)] as string;
      const changed = { ...schemas, [target]: { ...schemas[target], title: "changed" } };
      const [before, after] = [meanings(operations(schemas)), meanings(operations(changed))];
      const expected = names
        .filter((name) => before.get(name) !== after.get(name))
        .map((name) => `GET /${name}`)
        .sort();
      expect(
        changedBetween(operations(schemas), operations(changed)).sort(),
        `seed ${seed}`,
      ).toEqual(expected);

      // Across two documents: a component is shared when it means the same in both, renamed when not.
      const { notes } = mergeDocuments([
        { name: "Core", doc: operations(schemas) },
        { name: "Other", doc: operations(changed), pathPrefix: "/other" },
      ]);
      const renamed = notes.flatMap((note) =>
        note.kind === "component-renamed" ? [note.from] : [],
      );
      expect(renamed.sort(), `seed ${seed}`).toEqual(
        names.filter((name) => before.get(name) !== after.get(name)).sort(),
      );
    }
  });
});
