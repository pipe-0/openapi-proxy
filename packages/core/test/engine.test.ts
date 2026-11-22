import { validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import {
  applyVariant,
  findExternalRefs,
  fingerprintOperations,
  indexOperations,
  isValidSlug,
  type JsonObject,
  type OpenAPIDocument,
  parseSpec,
  type Selection,
} from "../src/index.js";
import { expectSecuritySchemesResolve, expectSelfContained, loadFixture } from "./helpers.js";

const ok = { "200": { description: "ok" } };
const jsonBody = (ref: string) => ({
  "200": { description: "ok", content: { "application/json": { schema: { $ref: ref } } } },
});
const include = (operations: string[], tags: string[] = []): Selection => ({
  mode: "include",
  operations,
  tags,
});
const everything: Selection = { mode: "exclude", operations: [], tags: [] };

function keys(doc: OpenAPIDocument): string[] {
  return indexOperations(doc).entries.map((entry) => entry.key);
}

function schemaNames(doc: OpenAPIDocument): string[] {
  const components = (doc.components ?? {}) as JsonObject;
  return Object.keys((components.schemas ?? {}) as JsonObject).sort();
}

describe("webhooks follow the selection", () => {
  const hooks = loadFixture("webhooks.json");

  it("indexes webhooks with their own key shape", () => {
    const entry = indexOperations(hooks).entries.find((e) => e.webhook);
    expect(entry).toMatchObject({ key: "POST webhook:newEvent", method: "POST", path: "newEvent" });
  });

  it("include mode drops webhooks that were not selected, and their schemas", () => {
    const { doc } = applyVariant(hooks, include(["POST /subscriptions"]));
    expect(doc.webhooks).toEqual({});
    expect(doc.components).toBeUndefined();
  });

  it("a selected webhook is served with its transitive schemas", () => {
    const { doc, stats } = applyVariant(hooks, include(["POST webhook:newEvent"]));
    expect(keys(doc)).toEqual(["POST webhook:newEvent"]);
    expect(doc.paths).toEqual({});
    expect(schemaNames(doc)).toEqual(["Event", "WebhookPayload"]);
    expect(stats.keptOperations).toBe(1);
  });

  it("exclude mode keeps webhooks unless they are excluded", () => {
    expect(applyVariant(hooks, everything).doc.webhooks).toEqual(hooks.webhooks);
    const { doc } = applyVariant(hooks, {
      mode: "exclude",
      operations: ["POST webhook:newEvent"],
      tags: [],
    });
    expect(doc.webhooks).toEqual({});
    expect(schemaNames(doc)).toEqual(["Event"]);
  });

  it("tag rules cover webhooks and keep their tag declarations", () => {
    const doc: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      tags: [{ name: "events" }, { name: "admin" }],
      paths: { "/a": { get: { tags: ["admin"], responses: ok } } },
      webhooks: { shipped: { post: { tags: ["events"], responses: ok } } },
    };
    const { doc: out } = applyVariant(doc, include([], ["events"]));
    expect(keys(out)).toEqual(["POST webhook:shipped"]);
    expect(out.tags).toEqual([{ name: "events" }]);
  });
});

describe("OpenAPI 3.2", () => {
  const doc: OpenAPIDocument = {
    openapi: "3.2.0",
    info: { title: "t", version: "1" },
    tags: [
      { name: "catalog" },
      { name: "books", parent: "catalog" },
      { name: "internal", parent: "ops" },
      { name: "ops" },
    ],
    paths: {
      "/books": {
        get: { tags: ["books"], responses: ok },
        query: {
          tags: ["internal"],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { $ref: "#/components/mediaTypes/Search" } },
            },
          },
        },
        additionalOperations: {
          COPY: { tags: ["internal"], responses: jsonBody("#/components/schemas/CopyResult") },
          PURGE: { tags: ["books"], responses: ok },
        },
      },
    },
    components: {
      schemas: {
        CopyResult: { type: "object" },
        Hit: { type: "object" },
      },
      mediaTypes: {
        Search: { schema: { $ref: "#/components/schemas/Hit" } },
        Unused: { schema: { type: "string" } },
      },
    },
  };

  it("indexes `query` and `additionalOperations`", () => {
    expect(keys(doc)).toEqual(["GET /books", "QUERY /books", "COPY /books", "PURGE /books"]);
  });

  it("does not leak unselected `query` or custom-method operations", () => {
    const { doc: out } = applyVariant(doc, include([], ["books"]));
    expect(keys(out)).toEqual(["GET /books", "PURGE /books"]);
    const item = (out.paths as JsonObject)["/books"] as JsonObject;
    expect(item.query).toBeUndefined();
    expect(Object.keys(item.additionalOperations as JsonObject)).toEqual(["PURGE"]);
    expect(out.components).toBeUndefined();
  });

  it("prunes `components.mediaTypes` by reference like any other group", () => {
    const { doc: out } = applyVariant(doc, include(["QUERY /books"]));
    const components = out.components as JsonObject;
    expect(Object.keys(components.mediaTypes as JsonObject)).toEqual(["Search"]);
    expect(schemaNames(out)).toEqual(["Hit"]);
    expectSelfContained(out);
  });

  it("keeps the ancestors of a kept tag", () => {
    const { doc: out } = applyVariant(doc, include(["GET /books"]));
    expect((out.tags as Array<{ name: string }>).map((tag) => tag.name)).toEqual([
      "catalog",
      "books",
    ]);
  });
});

describe("components we do not prune", () => {
  const doc: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    "x-shared": { defaultError: { $ref: "#/components/schemas/Problem" } },
    paths: { "/a": { get: { responses: ok } } },
    components: {
      schemas: {
        Problem: { type: "object" },
        ViaExtension: { type: "object" },
        Dead: { type: "object" },
      },
      "x-internal": { Anything: { $ref: "#/components/schemas/ViaExtension" } },
      "x-flag": true,
    },
  };

  it("copies extension groups verbatim and treats them as reference roots", () => {
    const { doc: out } = applyVariant(doc, include(["GET /a"]));
    const components = out.components as JsonObject;
    expect(components["x-internal"]).toEqual(
      (doc.components as JsonObject)["x-internal"] as JsonObject,
    );
    expect(components["x-flag"]).toBe(true);
    // Problem via the top-level extension, ViaExtension via the component extension.
    expect(schemaNames(out)).toEqual(["Problem", "ViaExtension"]);
    expectSelfContained(out);
  });
});

describe("x-tagGroups", () => {
  it("drops removed tags and empty groups", () => {
    const doc: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      tags: [{ name: "a" }, { name: "b" }, { name: "c" }],
      "x-tagGroups": [
        { name: "Public", tags: ["a", "b"] },
        { name: "Private", tags: ["c"] },
      ],
      paths: {
        "/a": { get: { tags: ["a"], responses: ok } },
        "/b": { get: { tags: ["b"], responses: ok } },
        "/c": { get: { tags: ["c"], responses: ok } },
      },
    };
    const { doc: out } = applyVariant(doc, include([], ["a"]));
    expect(out["x-tagGroups"]).toEqual([{ name: "Public", tags: ["a"] }]);
    // Untouched groups are passed through by identity.
    const all = applyVariant(doc, everything).doc["x-tagGroups"] as unknown[];
    expect(all[0]).toBe((doc["x-tagGroups"] as unknown[])[0]);
  });
});

describe("path items behind a $ref", () => {
  const doc: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/pets": { $ref: "#/components/pathItems/Pets" },
      "/other": { get: { responses: ok } },
    },
    components: {
      pathItems: {
        Pets: {
          parameters: [{ $ref: "#/components/parameters/Trace" }],
          get: { responses: jsonBody("#/components/schemas/Pet") },
          post: { responses: ok },
        },
      },
      parameters: { Trace: { name: "x-trace", in: "header", schema: { type: "string" } } },
      schemas: { Pet: { type: "object" } },
    },
  };

  it("indexes the operations of the referenced item under the real path", () => {
    expect(keys(doc)).toEqual(["GET /pets", "POST /pets", "GET /other"]);
  });

  it("keeps the reference when every operation is kept", () => {
    const { doc: out } = applyVariant(doc, include(["GET /pets", "POST /pets"]));
    expect((out.paths as JsonObject)["/pets"]).toEqual({ $ref: "#/components/pathItems/Pets" });
    expect(Object.keys((out.components as JsonObject).pathItems as JsonObject)).toEqual(["Pets"]);
    expectSelfContained(out);
  });

  it("inlines the item when only some operations are kept", () => {
    const { doc: out } = applyVariant(doc, include(["GET /pets"]));
    const item = (out.paths as JsonObject)["/pets"] as JsonObject;
    expect(Object.keys(item)).toEqual(["parameters", "get"]);
    expect((out.components as JsonObject).pathItems).toBeUndefined();
    expect(schemaNames(out)).toEqual(["Pet"]);
    expectSelfContained(out);
  });

  it("drops the path when none of its operations are kept", () => {
    const { doc: out } = applyVariant(doc, include(["GET /other"]));
    expect(Object.keys(out.paths as JsonObject)).toEqual(["/other"]);
    expect(out.components).toBeUndefined();
  });
});

describe("refs that point into operations", () => {
  // The shape bundlers produce: later occurrences point at the first one.
  const USER = "#/paths/~1users/get/responses/200/content/application~1json/schema";
  const doc: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/users": {
        get: {
          tags: ["internal"],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      manager: { $ref: USER },
                      team: { $ref: "#/components/schemas/Team" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/me": { get: { tags: ["public"], responses: jsonBody(USER) } },
      "/me/manager": {
        get: { tags: ["public"], responses: jsonBody(`${USER}/properties/manager`) },
      },
    },
    components: { schemas: { Team: { type: "object" }, Dead: { type: "object" } } },
  };
  const pristine = structuredClone(doc);

  it("leaves refs alone while their target is still served", () => {
    const { doc: out, stats } = applyVariant(doc, everything);
    expect(stats.inlinedRefs).toBe(0);
    expect((out.paths as JsonObject)["/me"]).toBe((doc.paths as JsonObject)["/me"]);
    expectSelfContained(out);
  });

  it("inlines the target when its operation is removed, once", async () => {
    const { doc: out, stats } = applyVariant(doc, include([], ["public"]));
    expect(doc).toEqual(pristine);
    expect(keys(out)).toEqual(["GET /me", "GET /me/manager"]);
    expect(stats.inlinedRefs).toBe(1);

    const copyAt = "#/paths/~1me/get/responses/200/content/application~1json/schema";
    const schemaOf = (path: string) =>
      (
        (
          (((out.paths as JsonObject)[path] as JsonObject).get as JsonObject)
            .responses as JsonObject
        )["200"] as { content: { "application/json": { schema: JsonObject } } }
      ).content["application/json"].schema;

    const copy = schemaOf("/me");
    expect(copy.type).toBe("object");
    // The recursive ref and the later ref both point at the copy.
    expect((copy.properties as JsonObject).manager).toEqual({ $ref: copyAt });
    expect(schemaOf("/me/manager")).toEqual({ $ref: `${copyAt}/properties/manager` });
    // Components reachable only through the inlined copy survive pruning.
    expect(schemaNames(out)).toEqual(["Team"]);

    expectSelfContained(out);
    expect(applyVariant(out, include([], ["public"])).doc).toEqual(out);

    const verdict = await validate(out);
    expect(verdict.errors ?? []).toEqual([]);
    expect(verdict.valid).toBe(true);
  });
});

describe("polymorphism without a list of members", () => {
  // `Event` names no subtypes: they are the schemas that extend it through allOf.
  const doc = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/events": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } },
            },
          },
        },
      },
      "/other": { get: { responses: { "200": { description: "ok" } } } },
    },
    components: {
      schemas: {
        Event: {
          type: "object",
          discriminator: { propertyName: "kind" },
          properties: { kind: { type: "string" } },
        },
        Created: {
          allOf: [{ $ref: "#/components/schemas/Event" }, { $ref: "#/components/schemas/Actor" }],
        },
        Deleted: { allOf: [{ $ref: "#/components/schemas/Event" }] },
        Actor: { type: "object", properties: { name: { type: "string" } } },
        // Extends something, but not a family: nothing implies it.
        Unrelated: { allOf: [{ $ref: "#/components/schemas/Actor" }] },
      },
    },
  };
  const schemasOf = (operations: string[]) =>
    Object.keys(
      (
        applyVariant(doc, { mode: "include", operations, tags: [] }).doc.components as {
          schemas?: object;
        }
      )?.schemas ?? {},
    ).sort();

  it("keeps the subtypes of a kept family, and what they use", () => {
    expect(schemasOf(["GET /events"])).toEqual(["Actor", "Created", "Deleted", "Event"]);
  });

  it("keeps none of it when the family is not served", () => {
    expect(schemasOf(["GET /other"])).toEqual([]);
  });

  it("counts a change to a subtype as a change to the operations that return the family", () => {
    const before = fingerprintOperations(doc);
    const changed = structuredClone(doc);
    (changed.components.schemas.Deleted as Record<string, unknown>).description = "Gone for good";
    const after = fingerprintOperations(changed);
    expect(after.get("GET /events")).not.toBe(before.get("GET /events"));
    expect(after.get("GET /other")).toBe(before.get("GET /other"));
  });
});

describe("invariants on generated selections", () => {
  // Every single-operation variant of every fixture must stand on its own.
  for (const fixture of [
    "petstore-3.0.yaml",
    "cycles.json",
    "discriminator.json",
    "security-schemes.json",
    "webhooks.json",
    "pipe0.json",
  ]) {
    it(`${fixture}: each operation alone yields a self-contained document`, () => {
      const source = loadFixture(fixture);
      for (const entry of indexOperations(source).entries) {
        const { doc, stats } = applyVariant(source, include([entry.key]));
        expect(keys(doc)).toEqual([entry.key]);
        expect(stats.keptOperations).toBe(1);
        expectSelfContained(doc);
        expectSecuritySchemesResolve(doc);
      }
    });
  }
});

describe("parsing edge cases", () => {
  it("accepts a JSON document with a byte order mark", () => {
    const text = `﻿${JSON.stringify({ openapi: "3.1.0", info: {}, paths: {} })}`;
    expect(parseSpec(text).format).toBe("json");
  });

  it("does not mistake a root self-reference for an external file", () => {
    expect(findExternalRefs({ a: { $ref: "#" }, b: { $ref: "#/components/schemas/A" } })).toEqual(
      [],
    );
    expect(findExternalRefs({ a: { $ref: "other.yaml" } })).toEqual(["other.yaml"]);
  });

  it("counts an operation once per tag even if the tag is repeated", () => {
    const index = indexOperations({
      openapi: "3.1.0",
      paths: { "/a": { get: { tags: ["x", "x"], responses: ok } } },
    });
    expect(index.tags).toEqual([{ name: "x", count: 1 }]);
  });
});

describe("slugs", () => {
  it("accepts short readable slugs and rejects stray hyphens", () => {
    for (const slug of ["v1", "sdk", "public-docs", "pipe0"]) expect(isValidSlug(slug)).toBe(true);
    for (const slug of ["a", "-docs", "docs-", "Docs", "my.docs", "a b", ""]) {
      expect(isValidSlug(slug)).toBe(false);
    }
  });
});
