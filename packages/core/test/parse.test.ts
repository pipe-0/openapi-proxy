import { describe, expect, it } from "vitest";
import { findExternalRefs, parseSpec, SpecParseError } from "../src/index.js";
import { loadFixtureText } from "./helpers.js";

describe("parseSpec", () => {
  it("parses JSON and reports the spec version", () => {
    const parsed = parseSpec(loadFixtureText("pipe0.json"));
    expect(parsed.format).toBe("json");
    expect(parsed.specVersion).toBe("3.1");
  });

  it("parses YAML", () => {
    const parsed = parseSpec(loadFixtureText("petstore-3.0.yaml"));
    expect(parsed.format).toBe("yaml");
    expect(parsed.specVersion).toBe("3.0");
    expect(parsed.doc.openapi).toBe("3.0.3");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseSpec("{ not json")).toThrowError(SpecParseError);
    try {
      parseSpec("{ not json");
    } catch (error) {
      expect((error as SpecParseError).code).toBe("invalid-syntax");
    }
  });

  it("rejects non-OpenAPI documents", () => {
    try {
      parseSpec(JSON.stringify({ hello: "world" }));
      expect.unreachable();
    } catch (error) {
      expect((error as SpecParseError).code).toBe("not-openapi");
    }
  });

  it("turns away a document that has a key named __proto__, however it is written", () => {
    const minimal = '"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{}';
    const texts = [
      `{${minimal},"components":{"__proto__":{"polluted":{"type":"string"}}}}`,
      // The same key, written with escapes.
      `{${minimal},"components":{"schemas":{"\\u005f\\u005fproto\\u005f\\u005f":{}}}}`,
      // Deep inside an example, in a list.
      `{${minimal},"x-samples":[{"value":{"__proto__":{"polluted":true}}}]}`,
      'openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths: {}\ncomponents:\n  __proto__:\n    polluted: { type: string }\n',
    ];
    for (const text of texts) {
      expect(() => parseSpec(text), text).toThrowError(/__proto__/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // The word in a description is nobody's business.
    const mentioned = `{${minimal.replace('"t"', '"About __proto__"')}}`;
    expect(parseSpec(mentioned).doc.info).toMatchObject({ title: "About __proto__" });
  });

  it("rejects Swagger 2.0 with a specific message", () => {
    try {
      parseSpec(JSON.stringify({ swagger: "2.0", info: {} }));
      expect.unreachable();
    } catch (error) {
      expect((error as SpecParseError).code).toBe("unsupported-version");
      expect((error as SpecParseError).message).toContain("Swagger 2.0");
    }
  });

  it("rejects empty input", () => {
    expect(() => parseSpec("   \n ")).toThrowError(SpecParseError);
  });
});

describe("findExternalRefs", () => {
  it("finds refs pointing outside the document", () => {
    const doc = {
      openapi: "3.1.0",
      paths: {
        "/a": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "./shared.yaml#/components/schemas/Thing" },
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(findExternalRefs(doc)).toEqual(["./shared.yaml#/components/schemas/Thing"]);
  });

  it("returns nothing for self-contained documents", () => {
    const { doc } = { doc: JSON.parse(loadFixtureText("pipe0.json")) };
    expect(findExternalRefs(doc)).toEqual([]);
  });
});
