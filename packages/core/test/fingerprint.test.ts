import { describe, expect, it } from "vitest";
import { fingerprintOperations } from "../src/index";

const base = () => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  security: [{ bearer: [] }],
  paths: {
    "/pets": {
      parameters: [{ $ref: "#/components/parameters/Tenant" }],
      get: {
        summary: "List pets",
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PetList" } } },
          },
        },
      },
      post: { security: [], responses: { "201": { description: "created" } } },
    },
    "/health": { get: { security: [], responses: { "200": { description: "ok" } } } },
  },
  components: {
    parameters: { Tenant: { name: "tenant", in: "header", schema: { type: "string" } } },
    schemas: {
      PetList: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
      Pet: {
        type: "object",
        properties: { name: { type: "string" }, owner: { $ref: "#/components/schemas/Owner" } },
      },
      // A cycle: an owner has pets.
      Owner: { type: "object", properties: { pets: { $ref: "#/components/schemas/PetList" } } },
      Unrelated: { type: "object", properties: { secret: { type: "string" } } },
    },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
});

type Doc = ReturnType<typeof base>;

/** Which operations get a different fingerprint after `edit`. */
function changed(edit: (doc: Doc) => void): string[] {
  const before = fingerprintOperations(base());
  const doc = base();
  edit(doc);
  const after = fingerprintOperations(doc);
  return [...before.keys()].filter((key) => before.get(key) !== after.get(key)).sort();
}

describe("fingerprintOperations", () => {
  it("covers every operation and is the same for the same document", () => {
    const first = fingerprintOperations(base());
    expect([...first.keys()].sort()).toEqual(["GET /health", "GET /pets", "POST /pets"]);
    expect([...fingerprintOperations(base())]).toEqual([...first]);
    expect(new Set(first.values()).size).toBe(3);
  });

  it("changes with the operation's own lines", () => {
    expect(
      changed((doc) => {
        doc.paths["/pets"].get.summary = "List all pets";
      }),
    ).toEqual(["GET /pets"]);
  });

  it("changes with a schema the operation reaches only indirectly", () => {
    expect(
      changed((doc) => {
        (doc.components.schemas.Owner.properties as Record<string, unknown>).email = {
          type: "string",
        };
      }),
    ).toEqual(["GET /pets"]);
  });

  it("changes with what the path item shares", () => {
    expect(
      changed((doc) => {
        doc.components.parameters.Tenant.name = "x-tenant";
      }),
    ).toEqual(["GET /pets", "POST /pets"]);
  });

  it("follows the document's default security, for the operations that use it", () => {
    expect(
      changed((doc) => {
        doc.components.securitySchemes.bearer.scheme = "basic";
      }),
    ).toEqual(["GET /pets"]);
    expect(
      changed((doc) => {
        doc.security = [];
      }),
    ).toEqual(["GET /pets"]);
  });

  it("ignores everything the operation does not use", () => {
    expect(
      changed((doc) => {
        doc.components.schemas.Unrelated.properties.secret.type = "number";
        doc.info.version = "2";
        (doc.paths as Record<string, unknown>)["/new"] = {
          get: { responses: { "200": { description: "ok" } } },
        };
      }),
    ).toEqual([]);
  });

  it("ignores the order of keys", () => {
    expect(
      changed((doc) => {
        const { post, get, parameters } = doc.paths["/pets"];
        doc.paths["/pets"] = { post, parameters, get };
        const { Owner, Pet, ...rest } = doc.components.schemas;
        doc.components.schemas = { Owner, ...rest, Pet };
        const { properties, type } = doc.components.schemas.Pet;
        doc.components.schemas.Pet = { properties, type } as Doc["components"]["schemas"]["Pet"];
      }),
    ).toEqual([]);
  });
});
