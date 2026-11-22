import { describe, expect, it } from "vitest";
import {
  applyVariant,
  indexOperations,
  isJsonObject,
  type JsonObject,
  type Selection,
  serialize,
} from "../src/index.js";
import {
  expectKeyOrderPreserved,
  expectSecuritySchemesResolve,
  expectSelfContained,
  loadFixture,
} from "./helpers.js";

const FIXTURES = [
  "pipe0.json",
  "petstore-3.0.yaml",
  "cycles.json",
  "discriminator.json",
  "security-schemes.json",
  "webhooks.json",
] as const;

function selections(doc: JsonObject): Array<{ label: string; selection: Selection }> {
  const index = indexOperations(doc);
  const firstOp = index.entries[0]?.key ?? "";
  const lastOp = index.entries.at(-1)?.key ?? "";
  const firstTag = index.tags[0]?.name ?? "";
  return [
    {
      label: "include-ops",
      selection: { mode: "include", operations: [firstOp, lastOp], tags: [] },
    },
    { label: "include-tag", selection: { mode: "include", operations: [], tags: [firstTag] } },
    {
      label: "include-mixed",
      selection: { mode: "include", operations: [lastOp], tags: [firstTag] },
    },
    { label: "exclude-ops", selection: { mode: "exclude", operations: [firstOp], tags: [] } },
    { label: "exclude-tag", selection: { mode: "exclude", operations: [], tags: [firstTag] } },
    { label: "include-empty", selection: { mode: "include", operations: [], tags: [] } },
    { label: "exclude-empty", selection: { mode: "exclude", operations: [], tags: [] } },
  ];
}

describe("applyVariant invariants", () => {
  for (const fixture of FIXTURES) {
    describe(fixture, () => {
      const source = loadFixture(fixture);
      const pristine = structuredClone(source);

      for (const { label, selection } of selections(source)) {
        it(`${label}: output is self-contained, ordered, and input is untouched`, () => {
          const { doc: filtered, stats } = applyVariant(source, selection);

          expect(source).toEqual(pristine);
          expectSelfContained(filtered);
          expectSecuritySchemesResolve(filtered);
          expectKeyOrderPreserved(source, filtered);

          const sourcePaths = isJsonObject(source.paths) ? source.paths : {};
          const filteredPaths = isJsonObject(filtered.paths) ? filtered.paths : {};
          expectKeyOrderPreserved(sourcePaths, filteredPaths);

          expect(stats.keptOperations).toBe(indexOperations(filtered).totalOperations);
          expect(stats.totalOperations).toBe(indexOperations(source).totalOperations);

          // Idempotence: filtering the output with the same selection is a no-op.
          const again = applyVariant(filtered, selection);
          expect(again.doc).toEqual(filtered);
        });
      }
    });
  }
});

describe("selection semantics", () => {
  const petstore = loadFixture("petstore-3.0.yaml");

  it("include by operation keeps exactly those operations", () => {
    const { doc, stats } = applyVariant(petstore, {
      mode: "include",
      operations: ["GET /pets", "POST /pets"],
      tags: [],
    });
    const keys = indexOperations(doc).entries.map((e) => e.key);
    expect(keys.sort()).toEqual(["GET /pets", "POST /pets"]);
    expect(stats.keptOperations).toBe(2);
  });

  it("include by tag keeps every operation carrying the tag", () => {
    const { doc } = applyVariant(petstore, { mode: "include", operations: [], tags: ["pets"] });
    const keys = indexOperations(doc).entries.map((e) => e.key);
    expect(keys.sort()).toEqual(["GET /pets", "GET /pets/{petId}", "POST /pets"]);
  });

  it("exclude removes matches and keeps the rest", () => {
    const { doc } = applyVariant(petstore, { mode: "exclude", operations: [], tags: ["pets"] });
    const keys = indexOperations(doc).entries.map((e) => e.key);
    expect(keys).toEqual(["GET /stores"]);
  });

  it("operations and tags are OR-ed", () => {
    const { doc } = applyVariant(petstore, {
      mode: "include",
      operations: ["GET /stores"],
      tags: ["pets"],
    });
    expect(indexOperations(doc).totalOperations).toBe(4);
  });

  it("include-empty serves a valid but empty spec", () => {
    const { doc, stats } = applyVariant(petstore, { mode: "include", operations: [], tags: [] });
    expect(doc.paths).toEqual({});
    expect(doc.components).toBeUndefined();
    expect(doc.tags).toBeUndefined();
    expect(stats.keptOperations).toBe(0);
  });

  it("vanished selected operations are dropped silently and reported", () => {
    const { doc, stats } = applyVariant(petstore, {
      mode: "include",
      operations: ["GET /pets", "DELETE /gone"],
      tags: [],
    });
    expect(indexOperations(doc).entries.map((e) => e.key)).toEqual(["GET /pets"]);
    expect(stats.missingSelectedOperations).toEqual(["DELETE /gone"]);
  });
});

describe("component pruning", () => {
  const petstore = loadFixture("petstore-3.0.yaml");

  it("keeps the transitive closure and drops the rest", () => {
    const { doc } = applyVariant(petstore, {
      mode: "include",
      operations: ["GET /pets"],
      tags: [],
    });
    const components = doc.components as JsonObject;
    const schemas = components.schemas as JsonObject;
    // GET /pets → Pet → Category (transitive), default response → Error → Category
    expect(Object.keys(schemas).sort()).toEqual(["Category", "Pet"]);
    expect(Object.keys(components.parameters as JsonObject).sort()).toEqual(["Limit", "TraceId"]);
    expect(Object.keys(components.responses as JsonObject)).toEqual(["Error"]);
    // requestBodies (POST-only), examples (getPet-only), links (stores-only) all pruned
    expect(components.requestBodies).toBeUndefined();
    expect(components.examples).toBeUndefined();
    expect(components.links).toBeUndefined();
    expect(components.headers).toBeUndefined();
  });

  it("always drops never-referenced components", () => {
    const { doc } = applyVariant(petstore, { mode: "exclude", operations: [], tags: [] });
    const schemas = (doc.components as JsonObject).schemas as JsonObject;
    expect(schemas.Orphan).toBeUndefined();
  });

  it("handles circular schema references", () => {
    const cycles = loadFixture("cycles.json");
    const { doc } = applyVariant(cycles, { mode: "include", operations: ["GET /nodes"], tags: [] });
    const schemas = (doc.components as JsonObject).schemas as JsonObject;
    expect(Object.keys(schemas).sort()).toEqual(["Node", "NodeRef"]);
  });

  it("follows discriminator.mapping refs", () => {
    const disc = loadFixture("discriminator.json");
    const { doc } = applyVariant(disc, { mode: "include", operations: ["GET /animals"], tags: [] });
    const schemas = (doc.components as JsonObject).schemas as JsonObject;
    expect(Object.keys(schemas).sort()).toEqual(["Animal", "Cat", "Dog", "Lizard"]);
    expect(schemas.Plant).toBeUndefined();
  });

  it("keeps security schemes referenced by name, drops unused ones", () => {
    const sec = loadFixture("security-schemes.json");
    const { doc } = applyVariant(sec, { mode: "include", operations: ["GET /admin"], tags: [] });
    const schemes = ((doc.components as JsonObject).securitySchemes ?? {}) as JsonObject;
    // adminAuth via the kept op, globalAuth via root security; legacyAuth pruned.
    expect(Object.keys(schemes).sort()).toEqual(["adminAuth", "globalAuth"]);
  });

  it("keeps webhook payload schemas only while the webhook is served", () => {
    const hooks = loadFixture("webhooks.json");
    const { doc } = applyVariant(hooks, { mode: "exclude", operations: [], tags: [] });
    const schemas = (doc.components as JsonObject).schemas as JsonObject;
    expect(Object.keys(schemas).sort()).toEqual(["Event", "WebhookPayload"]);
    expect(schemas.Unrelated).toBeUndefined();
    expect(doc.webhooks).toEqual(hooks.webhooks);
  });
});

describe("tags array cleanup", () => {
  it("filters top-level tags to those on kept operations", () => {
    const petstore = loadFixture("petstore-3.0.yaml");
    const { doc } = applyVariant(petstore, { mode: "include", operations: [], tags: ["pets"] });
    const tags = doc.tags as Array<{ name: string }>;
    expect(tags.map((t) => t.name)).toEqual(["pets"]);
  });
});

describe("pipe0 reference spec", () => {
  const pipe0 = loadFixture("pipe0.json");

  it("filtering away the Pipes tag drops the 380 KB PipePayload schema", () => {
    const { doc } = applyVariant(pipe0, { mode: "exclude", operations: [], tags: ["Pipes"] });
    const schemas = (doc.components as JsonObject).schemas as JsonObject;
    expect(schemas.PipePayload).toBeUndefined();

    const originalSize = serialize(pipe0, "json").length;
    const filteredSize = serialize(doc, "json").length;
    expect(filteredSize).toBeLessThan(originalSize * 0.6);
  });

  it("keeping only Search keeps its transitive schema chain", () => {
    const { doc } = applyVariant(pipe0, { mode: "include", operations: [], tags: ["Search"] });
    const schemas = (doc.components as JsonObject).schemas as JsonObject;
    expect(schemas.SearchRequestSchema).toBeDefined();
    expect(schemas.SearchPayloadSchema).toBeDefined();
    expect(schemas.PipePayload).toBeUndefined();
  });

  it("select-all still prunes the 6 dead schemas", () => {
    const { doc, stats } = applyVariant(pipe0, { mode: "exclude", operations: [], tags: [] });
    expect(stats.keptOperations).toBe(30);
    const schemas = (doc.components as JsonObject).schemas as JsonObject;
    for (const dead of [
      "EffectsResponse",
      "EffectsValidateRequest",
      "EffectsValidateResponse",
      "ScheduleCreate",
      "ScheduleList",
      "SchedulePatch",
    ]) {
      expect(schemas[dead], `${dead} should be pruned`).toBeUndefined();
    }
  });
});
