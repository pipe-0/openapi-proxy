import { validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import { applyVariant, indexOperations, type Selection } from "../src/index.js";
import { loadFixture } from "./helpers.js";

/**
 * Independent judgment: every filtered output must be a *valid* OpenAPI document
 * according to a third-party validator, not merely self-contained by our own
 * definition. Dev-dependency only: the validator never ships at runtime.
 */
describe("validation oracle (@scalar/openapi-parser)", () => {
  const cases: Array<{ fixture: string; selection: Selection }> = [
    {
      fixture: "petstore-3.0.yaml",
      selection: { mode: "include", operations: [], tags: ["pets"] },
    },
    {
      fixture: "petstore-3.0.yaml",
      selection: { mode: "exclude", operations: [], tags: ["pets"] },
    },
    { fixture: "pipe0.json", selection: { mode: "include", operations: [], tags: ["Search"] } },
    { fixture: "pipe0.json", selection: { mode: "exclude", operations: [], tags: ["Pipes"] } },
    {
      fixture: "cycles.json",
      selection: { mode: "include", operations: ["GET /nodes"], tags: [] },
    },
    {
      fixture: "discriminator.json",
      selection: { mode: "include", operations: ["GET /animals"], tags: [] },
    },
    {
      fixture: "security-schemes.json",
      selection: { mode: "include", operations: ["GET /admin"], tags: [] },
    },
    {
      fixture: "webhooks.json",
      selection: { mode: "include", operations: ["GET /events"], tags: [] },
    },
  ];

  for (const { fixture, selection } of cases) {
    it(`${fixture} · ${selection.mode} [${[...selection.operations, ...selection.tags].join(", ")}]`, async () => {
      const source = loadFixture(fixture);
      const { doc } = applyVariant(source, selection);
      expect(indexOperations(doc).totalOperations).toBeGreaterThan(0);

      const result = await validate(doc);
      expect(result.errors ?? []).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }
});
