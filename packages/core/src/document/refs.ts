import { isJsonObject, type JsonObject } from "../types.js";
import { unescapePointerSegment } from "./pointer.js";

/** A component address inside the document, e.g. `{ group: "schemas", name: "Pet" }`. */
export interface ComponentRef {
  group: string;
  name: string;
}

const COMPONENT_REF_PATTERN = /^#\/components\/([^/]+)\/([^/]+)/;

/** Parse `#/components/<group>/<name>[/...]`. Refs deeper into a component still name it. */
export function parseComponentRef(ref: string): ComponentRef | undefined {
  const match = COMPONENT_REF_PATTERN.exec(ref);
  if (!match) return undefined;
  return {
    group: unescapePointerSegment(match[1] ?? ""),
    name: unescapePointerSegment(match[2] ?? ""),
  };
}

export interface RefScanResult {
  /** Components referenced via `$ref` or `discriminator.mapping`. */
  refs: ComponentRef[];
  /** Security scheme names referenced by key inside `security` requirement arrays. */
  securitySchemes: string[];
}

/**
 * Scan a node tree for everything that makes a component "used":
 * - `$ref: "#/components/<group>/<name>"` (also refs pointing *into* a component,
 *   e.g. `#/components/schemas/Pet/properties/id`, which keep `Pet` alive)
 * - `discriminator.mapping` values, which are ref strings without a `$ref` key
 * - `security` requirement objects, whose *keys* name entries in
 *   `components.securitySchemes` without any `$ref`
 */
export function scanRefs(root: unknown): RefScanResult {
  const refs = new Map<string, ComponentRef>();
  const securitySchemes = new Set<string>();
  const stack: unknown[] = [root];

  const addRef = (value: unknown) => {
    if (typeof value !== "string") return;
    const parsed = parseComponentRef(value);
    if (parsed) refs.set(`${parsed.group}/${parsed.name}`, parsed);
  };

  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isJsonObject(node)) continue;

    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") {
        addRef(value);
        continue;
      }
      if (key === "discriminator" && isJsonObject(value) && isJsonObject(value.mapping)) {
        for (const mapped of Object.values(value.mapping)) addRef(mapped);
        stack.push(value);
        continue;
      }
      if (key === "security" && Array.isArray(value)) {
        // Security requirement arrays: [{ bearerAuth: [] }, ...]. Keys are scheme names.
        // Matching on shape may over-collect from lookalike data (e.g. inside examples);
        // over-collection only retains an extra scheme, it never breaks a reference.
        for (const requirement of value) {
          if (!isJsonObject(requirement)) continue;
          for (const [schemeName, scopes] of Object.entries(requirement)) {
            if (Array.isArray(scopes)) securitySchemes.add(schemeName);
          }
        }
      }
      stack.push(value);
    }
  }

  return { refs: [...refs.values()], securitySchemes: [...securitySchemes] };
}

/**
 * Subtypes that no `$ref` points at. A schema with a `discriminator` describes
 * a family; unless it lists the members (`oneOf`, `anyOf`, `mapping`), they are
 * simply the schemas that extend it through `allOf`. Whoever receives the
 * parent can receive any of them, so they belong to it.
 *
 * Returns, for each schema that has a discriminator, the names of the schemas
 * extending it.
 */
export function implicitSubtypes(components: JsonObject | undefined): Map<string, string[]> {
  const subtypes = new Map<string, string[]>();
  const schemas = components?.schemas;
  if (!isJsonObject(schemas)) return subtypes;

  const families = new Set<string>();
  for (const [name, schema] of Object.entries(schemas)) {
    if (isJsonObject(schema) && isJsonObject(schema.discriminator)) families.add(name);
  }
  if (families.size === 0) return subtypes;

  for (const [name, schema] of Object.entries(schemas)) {
    if (!isJsonObject(schema) || !Array.isArray(schema.allOf)) continue;
    for (const part of schema.allOf) {
      const parent = isJsonObject(part) ? parseComponentRef(String(part.$ref ?? "")) : undefined;
      if (parent?.group !== "schemas" || !families.has(parent.name) || parent.name === name)
        continue;
      subtypes.set(parent.name, [...(subtypes.get(parent.name) ?? []), name]);
    }
  }
  return subtypes;
}

/**
 * Compute the transitive closure of components reachable from the given roots.
 * Cycles are handled with the visited set. Returns keys of the form
 * `<group>/<name>`; security schemes used by name are included as
 * `securitySchemes/<name>`, and the subtypes of a kept polymorphic schema as
 * `schemas/<name>` (see `implicitSubtypes`).
 */
export function componentClosure(
  roots: unknown[],
  components: JsonObject | undefined,
): Set<string> {
  const needed = new Set<string>();
  const queue: ComponentRef[] = [];
  const subtypes = implicitSubtypes(components);

  const need = (ref: ComponentRef) => {
    const key = `${ref.group}/${ref.name}`;
    if (needed.has(key)) return;
    needed.add(key);
    queue.push(ref);
  };

  const absorb = (scan: RefScanResult) => {
    for (const ref of scan.refs) need(ref);
    for (const name of scan.securitySchemes) need({ group: "securitySchemes", name });
  };

  for (const root of roots) absorb(scanRefs(root));

  for (let ref = queue.pop(); ref; ref = queue.pop()) {
    const group = components?.[ref.group];
    const body = isJsonObject(group) ? group[ref.name] : undefined;
    if (body === undefined) continue; // dangling ref in source; nothing to traverse
    absorb(scanRefs(body));
    if (ref.group === "schemas") {
      for (const name of subtypes.get(ref.name) ?? []) need({ group: "schemas", name });
    }
  }

  return needed;
}
