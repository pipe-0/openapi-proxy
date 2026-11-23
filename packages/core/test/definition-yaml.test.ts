import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { definitionYaml, type ProjectDefinition, readDefinition } from "../src/index.js";

const definitionOf = (input: unknown): ProjectDefinition => {
  const read = readDefinition(input);
  if ("problems" in read) throw new Error(JSON.stringify(read.problems));
  return read.definition;
};

describe("a definition as the text of a file", () => {
  it("is written the way a person would write it", () => {
    const definition = definitionOf({
      version: 1,
      project: "pipe0",
      name: "Pipe0 API",
      visibility: "private",
      overrides: { servers: [{ url: "https://api.pipe0.com", description: "Production" }] },
      sources: [
        { name: "core", url: "https://api.pipe0.com/doc", main: true, follow: true },
        { name: "billing", file: "./billing/openapi.yaml", pathPrefix: "/billing" },
      ],
      variants: {
        public: {
          name: "Public API",
          icon: "globe",
          visibility: "public",
          include: { tags: ["Pipes", "Search"], operations: ["GET /v1/credit-balance"] },
          exclude: { operations: ["POST /v1/pipes/validate", "GET /v1/pipes/{id}"] },
          overrides: { title: "Pipe0: the public API" },
        },
        nothing: { include: {} },
      },
    });
    expect(
      definitionYaml(definition),
    ).toBe(`# yaml-language-server: $schema=https://openapi-proxy.app/schema/definition.v1.json
version: 1
project: pipe0
name: Pipe0 API
visibility: private
overrides:
  servers:
    - url: https://api.pipe0.com
      description: Production

sources:
  - name: core
    url: https://api.pipe0.com/doc
    main: true
    follow: true
  - name: billing
    file: ./billing/openapi.yaml
    pathPrefix: /billing

variants:
  public:
    name: Public API
    icon: globe
    visibility: public
    include:
      tags: [Pipes, Search]
      operations:
        - GET /v1/credit-balance
    exclude:
      operations:
        - GET /v1/pipes/{id}
        - POST /v1/pipes/validate
    overrides:
      title: "Pipe0: the public API"
  nothing:
    include: {}
`);
  });

  it("reads back as the definition it was written from", () => {
    const examples = join(import.meta.dirname, "../../../examples");
    for (const name of readdirSync(examples, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const text = readFileSync(join(examples, name.name, "openapi-proxy.yaml"), "utf8");
      const definition = definitionOf(parse(text));
      expect(definitionOf(parse(definitionYaml(definition))), name.name).toEqual(definition);
    }
  });
});
