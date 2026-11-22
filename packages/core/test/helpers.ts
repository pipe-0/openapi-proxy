import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { isJsonObject, type JsonObject, type OpenAPIDocument, parseSpec } from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixtureText(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

export function loadFixture(name: string): OpenAPIDocument {
  return parseSpec(loadFixtureText(name)).doc;
}

/** Every component ref used anywhere in the doc, as `#/components/...` strings. */
export function collectComponentRefs(doc: OpenAPIDocument): string[] {
  const refs: string[] = [];
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isJsonObject(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      if (key === "discriminator" && isJsonObject(value) && isJsonObject(value.mapping)) {
        for (const mapped of Object.values(value.mapping)) {
          // A mapping value is a reference, or just the name of a schema.
          if (typeof mapped === "string") {
            refs.push(mapped.startsWith("#") ? mapped : `#/components/schemas/${mapped}`);
          }
        }
      }
      stack.push(value);
    }
  }
  return refs;
}

/** Assert that every `$ref` (and discriminator mapping) in the doc resolves inside the doc. */
export function expectSelfContained(doc: OpenAPIDocument): void {
  for (const ref of collectComponentRefs(doc)) {
    expect(ref.startsWith("#/"), `external ref in output: ${ref}`).toBe(true);
    const segments = ref
      .slice(2)
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node: unknown = doc;
    for (const segment of segments) {
      expect(
        isJsonObject(node) || Array.isArray(node),
        `dangling ref in output: ${ref} (stopped at "${segment}")`,
      ).toBe(true);
      node = Array.isArray(node) ? node[Number(segment)] : (node as JsonObject)[segment];
    }
    expect(node, `dangling ref in output: ${ref}`).toBeDefined();
  }
}

/** Assert `subset`'s keys appear in the same relative order as they do in `source`. */
export function expectKeyOrderPreserved(source: JsonObject, subset: JsonObject): void {
  const subsetKeys = Object.keys(subset);
  const expected = Object.keys(source).filter((key) => subsetKeys.includes(key));
  const inherited = subsetKeys.filter((key) => key in source);
  expect(inherited).toEqual(expected);
}

/** Assert every security scheme named in a `security` requirement exists in components. */
export function expectSecuritySchemesResolve(doc: OpenAPIDocument): void {
  const components = isJsonObject(doc.components) ? doc.components : {};
  const schemes = isJsonObject(components.securitySchemes) ? components.securitySchemes : {};
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isJsonObject(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === "security" && Array.isArray(value)) {
        for (const requirement of value) {
          if (!isJsonObject(requirement)) continue;
          for (const [name, scopes] of Object.entries(requirement)) {
            if (Array.isArray(scopes)) {
              expect(
                schemes[name],
                `security scheme "${name}" pruned but still used`,
              ).toBeDefined();
            }
          }
        }
      }
      stack.push(value);
    }
  }
}
