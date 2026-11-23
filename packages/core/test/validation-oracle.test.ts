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
      selection: { include: { tags: ["pets"] } },
    },
    {
      fixture: "petstore-3.0.yaml",
      selection: { exclude: { tags: ["pets"] } },
    },
    { fixture: "pipe0.json", selection: { include: { tags: ["Search"] } } },
    { fixture: "pipe0.json", selection: { exclude: { tags: ["Pipes"] } } },
    {
      fixture: "cycles.json",
      selection: { include: { operations: ["GET /nodes"] } },
    },
    {
      fixture: "discriminator.json",
      selection: { include: { operations: ["GET /animals"] } },
    },
    {
      fixture: "security-schemes.json",
      selection: { include: { operations: ["GET /admin"] } },
    },
    {
      fixture: "webhooks.json",
      selection: { include: { operations: ["GET /events"] } },
    },
  ];

  for (const { fixture, selection } of cases) {
    it(`${fixture} · ${JSON.stringify(selection)}`, async () => {
      const source = loadFixture(fixture);
      const { doc } = applyVariant(source, selection);
      expect(indexOperations(doc).totalOperations).toBeGreaterThan(0);

      const result = await validate(doc);
      expect(result.errors ?? []).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }
});
