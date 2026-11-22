import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  buildVariant,
  type OpenAPIDocument,
  readOverrides,
  type Selection,
} from "../src/index.js";

const everything: Selection = { mode: "exclude", operations: [], tags: [] };
const doc: OpenAPIDocument = {
  openapi: "3.1.0",
  info: { title: "Internal API", version: "4.2.0", description: "For us." },
  servers: [{ url: "http://localhost:8080" }],
  paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
};

describe("what a variant states at the top of its document", () => {
  it("takes the place of the source's title, description and servers, and of nothing else", () => {
    const out = applyOverrides(doc, {
      title: "Acme API",
      servers: [
        { url: "https://api.acme.com", description: "Production" },
        { url: "https://sandbox.acme.com" },
      ],
    });
    expect(out.info).toEqual({ title: "Acme API", version: "4.2.0", description: "For us." });
    expect(out.servers).toEqual([
      { url: "https://api.acme.com", description: "Production" },
      { url: "https://sandbox.acme.com" },
    ]);
    expect(Object.keys(out)).toEqual(Object.keys(doc));
    expect(out.paths).toBe(doc.paths);
    // The source is never changed, and without overrides it is what is served.
    expect(doc.servers).toEqual([{ url: "http://localhost:8080" }]);
    expect(applyOverrides(doc, null)).toBe(doc);
    expect(applyOverrides(doc, {})).toBe(doc);
  });

  it("puts servers after info in a document that lists none", () => {
    const { servers: _none, ...bare } = doc;
    const out = applyOverrides(bare, { servers: [{ url: "/v1" }] });
    expect(Object.keys(out)).toEqual(["openapi", "info", "servers", "paths"]);
  });

  it("is part of what a variant serves, in whichever version", () => {
    const built = buildVariant(doc, {
      selection: everything,
      version: "3.0",
      overrides: { description: "For everyone.", servers: [{ url: "https://api.acme.com" }] },
    });
    expect(built.doc).toMatchObject({
      openapi: "3.0.3",
      info: { title: "Internal API", description: "For everyone." },
      servers: [{ url: "https://api.acme.com" }],
    });
  });

  it("is read from what people send: trimmed, empty means none, and a URL has to be one", () => {
    expect(readOverrides(null)).toBeNull();
    expect(readOverrides({ title: "  ", servers: [] })).toBeNull();
    expect(
      readOverrides({
        title: " Acme ",
        servers: [{ url: " https://api.acme.com ", description: " Production " }, { url: "/v1" }],
      }),
    ).toEqual({
      title: "Acme",
      servers: [{ url: "https://api.acme.com", description: "Production" }, { url: "/v1" }],
    });
    for (const servers of [
      [{ url: "api.acme.com" }],
      [{ url: "https://{region}.acme.com" }],
      [{ url: "https://a b.com" }],
      [{}],
      "https://api.acme.com",
      Array.from({ length: 21 }, () => ({ url: "/a" })),
    ]) {
      expect(readOverrides({ servers })).toHaveProperty("problem");
    }
    expect(readOverrides({ title: "x".repeat(201) })).toHaveProperty("problem");
    expect(readOverrides("Acme")).toHaveProperty("problem");
  });
});
