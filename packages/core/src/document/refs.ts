import { isJsonObject, type JsonObject } from "../types.js";
import { spend } from "./budget.js";
import { pointerSegments, pointerTo } from "./pointer.js";
import { walk } from "./walk.js";

/** A component address inside the document, e.g. `{ group: "schemas", name: "Pet" }`. */
export interface ComponentRef {
  group: string;
  name: string;
}

/**
 * Parse `#/components/<group>/<name>[/...]`. Refs deeper into a component
 * still name it. A reference is a URI fragment, so the name may be written
 * with percent escapes (`Page%C2%ABUser%C2%BB` for `Page«User»`, as several
 * generators do); it is read the way a reference is resolved.
 */
export function parseComponentRef(ref: string): ComponentRef | undefined {
  if (!ref.startsWith("#/components/")) return undefined;
  const [, group, name] = pointerSegments(ref) ?? [];
  return group === undefined || name === undefined ? undefined : { group, name };
}

/** The one spelling of the place a component is at. */
export function componentPlace(group: string, name: string): string {
  return pointerTo(["components", group, name]);
}

/** Everything a part of a document mentions that lies somewhere else. */
export interface RefScanResult {
  /** Components referenced via `$ref` or by a discriminator. */
  refs: ComponentRef[];
  /** Security scheme names referenced by key inside `security` requirement arrays. */
  securitySchemes: string[];
  /**
   * References to places in the document that are not components, each in
   * its one spelling (`pointerTo`): `#/paths/~1users/get/...`, as bundlers
   * write them.
   */
  pointers: string[];
  /** References that point outside the document, which nothing here resolves. */
  external: string[];
}

/**
 * Scan a node tree for everything that makes a component "used":
 * - `$ref: "#/components/<group>/<name>"` (also refs pointing *into* a component,
 *   e.g. `#/components/schemas/Pet/properties/id`, which keep `Pet` alive)
 * - what a `discriminator` names in `mapping` and `defaultMapping`: ref strings
 *   without a `$ref` key, or just the name of a schema
 * - `security` requirement objects, whose *keys* name entries in
 *   `components.securitySchemes` without any `$ref`
 */
export function scanRefs(root: unknown): RefScanResult {
  const refs = new Map<string, ComponentRef>();
  const securitySchemes = new Set<string>();
  const pointers = new Set<string>();
  const external = new Set<string>();

  const addRef = (value: string) => {
    if (!value.startsWith("#")) {
      external.add(value);
      return;
    }
    const segments = pointerSegments(value);
    if (!segments) return;
    const [first, group, name] = segments;
    if (first === "components" && group !== undefined && name !== undefined) {
      refs.set(componentPlace(group, name), { group, name });
    } else if (segments.length > 0) {
      pointers.add(pointerTo(segments));
    }
  };
  /**
   * What a discriminator maps a value to: a reference, or the bare name of a
   * schema. A name no schema has changes nothing, so anything can pass for one.
   */
  const addMapped = (value: unknown) => {
    if (typeof value !== "string") return;
    if (value.startsWith("#")) addRef(value);
    else refs.set(componentPlace("schemas", value), { group: "schemas", name: value });
  };

  walk(root, {
    keyword(key, value) {
      if (key === "$ref" && typeof value === "string") {
        addRef(value);
        return value;
      }
      if (key === "discriminator" && isJsonObject(value)) {
        if (isJsonObject(value.mapping)) {
          const mapped = Object.values(value.mapping);
          spend(mapped.length);
          for (const to of mapped) addMapped(to);
        }
        addMapped(value.defaultMapping);
        return value;
      }
      if (key === "security" && Array.isArray(value)) {
        // Security requirements: [{ bearerAuth: [] }, ...]. Their keys are names of schemes.
        for (const requirement of value) {
          if (!isJsonObject(requirement)) continue;
          const names = Object.keys(requirement);
          spend(names.length + 1);
          for (const name of names) securitySchemes.add(name);
        }
        return value;
      }
      return undefined;
    },
  });

  return {
    refs: [...refs.values()],
    securitySchemes: [...securitySchemes],
    pointers: [...pointers],
    external: [...external],
  };
}

/**
 * `$ref` values that point outside the document, i.e. anything that is not a
 * `#...` fragment. Used to reject multi-file specs up front with a clear
 * message instead of serving broken output later.
 */
export function findExternalRefs(doc: JsonObject): string[] {
  return scanRefs(doc).external;
}

/** Whether a schema describes a family: it has a discriminator, itself or in a part of its `allOf`. */
function hasDiscriminator(schema: JsonObject): boolean {
  if (isJsonObject(schema.discriminator)) return true;
  return (
    Array.isArray(schema.allOf) &&
    schema.allOf.some((part) => isJsonObject(part) && isJsonObject(part.discriminator))
  );
}

/**
 * Subtypes that no `$ref` points at. A schema with a `discriminator` describes
 * a family; unless it lists the members (`oneOf`, `anyOf`, `mapping`), they are
 * simply the schemas that extend it through `allOf`, and the schemas that
 * extend those. Whoever receives the parent can receive any of them, so they
 * belong to it.
 *
 * Returns, for each schema of such a family (its head and every member), the
 * names of the schemas that extend it directly. Following those from the head
 * reaches the whole family.
 */
export function implicitSubtypes(components: JsonObject | undefined): Map<string, string[]> {
  const subtypes = new Map<string, string[]>();
  const schemas = components?.schemas;
  if (!isJsonObject(schemas)) return subtypes;

  const heads: string[] = [];
  /** Every schema that is extended, with the schemas extending it, each once. */
  const extendedBy = new Map<string, Set<string>>();
  const names = Object.keys(schemas);
  spend(names.length);
  for (const name of names) {
    const schema = schemas[name];
    if (!isJsonObject(schema)) continue;
    if (hasDiscriminator(schema)) heads.push(name);
    if (!Array.isArray(schema.allOf)) continue;
    spend(schema.allOf.length);
    for (const part of schema.allOf) {
      const parent =
        isJsonObject(part) && typeof part.$ref === "string"
          ? parseComponentRef(part.$ref)
          : undefined;
      if (parent?.group !== "schemas" || parent.name === name) continue;
      const extenders = extendedBy.get(parent.name) ?? new Set<string>();
      extendedBy.set(parent.name, extenders);
      extenders.add(name);
    }
  }

  // From the heads down, each schema once.
  for (let name = heads.pop(); name !== undefined; name = heads.pop()) {
    const extenders = extendedBy.get(name);
    if (!extenders || subtypes.has(name)) continue;
    spend(extenders.size);
    subtypes.set(name, [...extenders]);
    heads.push(...extenders);
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
    spend();
    const group = components?.[ref.group];
    const body =
      isJsonObject(group) && Object.hasOwn(group, ref.name) ? group[ref.name] : undefined;
    if (body === undefined) continue; // dangling ref in source; nothing to traverse
    absorb(scanRefs(body));
    if (ref.group === "schemas") {
      for (const name of subtypes.get(ref.name) ?? []) need({ group: "schemas", name });
    }
  }

  return needed;
}
