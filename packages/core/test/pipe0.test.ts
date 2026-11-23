import { describe, expect, it } from "vitest";
import {
  applyVariant,
  effectiveVariant,
  indexOperations,
  type OpenAPIDocument,
  readDefinition,
} from "../src/index.js";
import { loadFixture } from "./helpers.js";

/**
 * The case this project exists for. pipe0's API generates one document for
 * everything it does, and a filter in its own code made the public one from
 * it: whole tags, plus two single paths. Two of those tags mix what its
 * client uses with routes that are only for its dashboard, which a filter by
 * tag cannot tell apart.
 *
 * The fixture is a document of that API. The definition says what the filter
 * could not: whole tags, minus the operations that are not for the public.
 */
const DEFINITION = {
  version: 1,
  project: "pipe0",
  sources: [{ url: "https://api.pipe0.com/doc" }],
  variants: {
    public: {
      include: {
        tags: ["Pipes", "Search", "Credit Balance"],
        operations: ["POST /v1/sheets/{sheet_id}/effects/run"],
      },
      exclude: {
        operations: [
          "POST /v1/pipes/validate",
          "POST /v1/pipes/connections",
          "POST /v1/pipes/field-context",
          "POST /v1/search/validate",
          "POST /v1/search/connections",
          "POST /v1/search/field-context",
        ],
      },
    },
  },
};

describe("pipe0's public document", () => {
  const full = loadFixture("pipe0.json");
  const read = readDefinition(DEFINITION);
  if ("problems" in read) throw new Error(JSON.stringify(read.problems));
  const { selection } = effectiveVariant(read.definition, "public");
  const keysOf = (doc: OpenAPIDocument) => indexOperations(doc).entries.map((entry) => entry.key);

  it("keeps whole tags and leaves single operations out of them", () => {
    const { doc, stats } = applyVariant(full, selection);
    expect(keysOf(doc).sort()).toEqual([
      "GET /v1/pipes/check/{run_id}",
      "GET /v1/search/check/{run_id}",
      "POST /v1/pipes/run",
      "POST /v1/pipes/run/sync",
      "POST /v1/search/run",
      "POST /v1/search/run/sync",
    ]);
    expect(stats.totalOperations).toBe(30);
  });

  it("says which names this document has nothing for, and is not stopped by them", () => {
    const { stats } = applyVariant(full, selection);
    expect(stats.unmatched).toEqual({
      include: {
        operations: ["POST /v1/sheets/{sheet_id}/effects/run"],
        tags: ["Credit Balance"],
      },
      exclude: { operations: [], tags: [] },
    });
  });

  it("serves what the API adds to an included tag later, without anyone listing it", () => {
    const later = structuredClone(full) as OpenAPIDocument & { paths: Record<string, unknown> };
    later.paths["/v1/pipes/added-later"] = {
      get: { tags: ["Pipes"], responses: { "200": { description: "ok" } } },
    };
    later.paths["/v1/credit-balance"] = {
      get: { tags: ["Credit Balance"], responses: { "200": { description: "ok" } } },
    };
    const kept = keysOf(applyVariant(later, selection).doc);
    expect(kept).toContain("GET /v1/pipes/added-later");
    expect(kept).toContain("GET /v1/credit-balance");
    expect(kept).not.toContain("POST /v1/pipes/validate");
  });
});
