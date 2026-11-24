import { type ProjectDefinition, readDefinition } from "@openapi-proxy/core";
import { describe, expect, it } from "vitest";
import { definitionFromRows, sourceColumns, variantColumns } from "../src/server/definition-rows";
import { applied, apply, document, getProject, login, SPEC_URL, serveSpec } from "./harness";

/** A definition as the server stores it: read, normalised, without where it is deployed to. */
function stored(input: unknown): ProjectDefinition {
  const read = readDefinition(input);
  if ("problems" in read) throw new Error(JSON.stringify(read.problems));
  delete read.definition.instance;
  return read.definition;
}

/** To rows and back, without a database in between. */
function roundTrip(definition: ProjectDefinition): ProjectDefinition {
  const several = definition.sources.length > 1;
  return definitionFromRows(
    {
      slug: definition.project,
      name: definition.name ?? null,
      visibility: definition.visibility ?? null,
      overrides: definition.overrides ?? null,
    },
    // Out of order, as a query without ORDER BY may return them.
    definition.sources
      .map((source, position) => ({ ...sourceColumns(source, several), position }))
      .reverse(),
    Object.entries(definition.variants)
      .map(([slug, variant], position) => ({ ...variantColumns(slug, variant), position }))
      .reverse(),
  );
}

const SAMPLES: Record<string, unknown> = {
  "the least a definition can say": {
    version: 1,
    project: "least",
    sources: [{ url: SPEC_URL }],
  },
  "one followed source and a variant of everything": {
    version: 1,
    project: "one",
    sources: [{ url: SPEC_URL, follow: true }],
    variants: { public: {} },
  },
  "a file, with a name it does not need": {
    version: 1,
    project: "file",
    sources: [{ name: "core", file: "./openapi.yaml", pathPrefix: "v1" }],
    variants: { all: { name: "Everything" } },
  },
  "every key there is": {
    version: 1,
    project: "everything",
    name: "Everything API",
    instance: "https://proxy.example.com",
    visibility: "private",
    overrides: {
      title: "Everything",
      description: "All of it.",
      servers: [{ url: "https://api.example.com", description: "Production" }],
    },
    sources: [
      { name: "billing", file: "./billing/openapi.yaml", pathPrefix: "/billing" },
      { name: "core", url: SPEC_URL, main: true, follow: true },
      { name: "legacy", url: "https://legacy.example.com/openapi.json" },
    ],
    variants: {
      public: {
        name: "Public API",
        icon: "globe",
        visibility: "public",
        include: { tags: ["pets", "billing"], operations: ["GET /v1/credit-balance"] },
        exclude: { operations: ["POST /v1/pipes/validate"], tags: ["internal"] },
        overrides: { title: "Public", servers: [{ url: "https://public.example.com" }] },
      },
      nothing: { include: {} },
      "all-but": { exclude: { tags: ["internal"] } },
      partners: { visibility: "private", include: { operations: ["GET /pets"] } },
      // Written last; stored, like served, first.
      original: { visibility: "public" },
    },
  },
};

describe("a definition and the rows it is stored in", () => {
  it("leave out an original that says nothing, though every project has its row", () => {
    const definition = stored(SAMPLES["one followed source and a variant of everything"]);
    const rows = [
      { ...variantColumns("original", {}), position: 0 },
      { ...variantColumns("public", {}), position: 1 },
    ];
    expect(
      Object.keys(
        definitionFromRows(
          { slug: "one", name: null, visibility: null, overrides: null },
          [{ ...sourceColumns({ url: SPEC_URL, follow: true }, false), position: 0 }],
          rows,
        ).variants,
      ),
    ).toEqual(Object.keys(definition.variants));
  });

  for (const [what, input] of Object.entries(SAMPLES)) {
    it(`say the same thing: ${what}`, () => {
      const definition = stored(input);
      expect(roundTrip(definition)).toEqual(definition);
      // In the same order, too: sources as listed, variants as written.
      expect(JSON.stringify(roundTrip(definition))).toBe(JSON.stringify(definition));
    });
  }

  it("say the same thing after a trip through the database", async () => {
    const cookie = await login();
    serveSpec();
    const definition = stored(SAMPLES["every key there is"]);
    await applied(
      apply(cookie, SAMPLES["every key there is"] as Record<string, unknown>, {
        documents: {
          billing: document({
            openapi: "3.1.0",
            info: { title: "Billing", version: "1" },
            paths: { "/invoices": { get: { responses: { "200": { description: "ok" } } } } },
          }),
          legacy: document({
            openapi: "3.1.0",
            info: { title: "Legacy", version: "1" },
            paths: { "/old": { get: { responses: { "200": { description: "ok" } } } } },
          }),
        },
      }),
    );
    const read = await getProject(cookie, "everything");
    expect(read.definition).toEqual(definition);
    expect(JSON.stringify(read.definition)).toBe(JSON.stringify(definition));
    // Where it is deployed to is the deployer's business, and is not kept.
    expect(read.definition).not.toHaveProperty("instance");

    // Applied again as it was read, nothing about it changes.
    const again = await applied(apply(cookie, read.definition));
    expect(again.sources.map((source) => source.action)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(again.variants.map((variant) => variant.slug)).toEqual([
      "original",
      "public",
      "nothing",
      "all-but",
      "partners",
    ]);
    expect(new Set(again.variants.map((variant) => variant.action))).toEqual(
      new Set(["unchanged"]),
    );
    expect((await getProject(cookie, "everything")).definition).toEqual(definition);
  });
});
