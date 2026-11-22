import { isJsonObject, type JsonObject } from "../types.js";
import { spend } from "./budget.js";
import { OUTPUT_LIMITS, tooDeep } from "./limits.js";

/**
 * Going over a document to find or change what the specification gives a
 * meaning to: references, security requirements, operation ids. Everything
 * that does so goes through `walk`, so that all of it agrees on the one
 * question that is easy to get wrong: when is a key a keyword?
 *
 * Not always. Two kinds of places hold keys that mean nothing to the
 * specification, however they are spelled:
 *
 * - **Maps of names.** The keys under `properties`, `responses` or
 *   `components.schemas` are the author's: a property can be called `$ref`,
 *   a response `default`, a schema `security`. Only what they name is looked
 *   into.
 * - **Literal data.** An `example` or a `default` is the author's data. An
 *   API that returns OpenAPI documents or JSON Schemas shows exactly such
 *   keys in its examples, and none of them is a reference.
 *
 * It walks everything else, so a place the specification adds tomorrow is
 * covered, and it pays for what it looks at (document/budget.ts).
 */

/** Keys under which a document holds its author's own data. */
const LITERAL = new Set([
  "example",
  "default",
  "const",
  "enum",
  // In an Example Object.
  "value",
  "dataValue",
  "serializedValue",
  "externalValue",
]);

/** Keys whose value maps names to things. */
const NAMED = new Set([
  // In a schema.
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
  // In the rest of a document.
  "paths",
  "webhooks",
  "x-webhooks",
  "callbacks",
  "responses",
  "headers",
  "content",
  "encoding",
  "examples",
  "links",
  "variables",
  // The groups of `components` that are not already listed.
  "schemas",
  "parameters",
  "requestBodies",
  "securitySchemes",
  "pathItems",
  "mediaTypes",
]);

/** Where a walk is: the keys and list positions that lead here from its root. */
export type Path = ReadonlyArray<string | number>;

export interface Visitor {
  /**
   * Called for every object whose keys are keywords, before they are looked
   * at. Return what to put in its place, or nothing to go on into it. What
   * is returned is not walked; `into` walks a value as if it stood here, for
   * a replacement that has to be looked into as well.
   */
  object?(node: JsonObject, path: Path, into: (value: unknown) => unknown): unknown;
  /**
   * Called for each keyword and its value. Return what to put in the value's
   * place (the value itself to leave it as it is, unvisited), or nothing to
   * go on into it.
   */
  keyword?(key: string, value: unknown, parent: JsonObject): unknown;
}

/**
 * `root` with the visitor's replacements made. Whatever it left alone is
 * shared with `root`, not copied, and a visitor that replaces nothing gets
 * `root` itself back: that is how a walk only reads.
 *
 * A replacement can hold more than what it replaces, to any depth (a
 * reference swapped for its target, which holds a reference). So the depth
 * is watched here, for every walk.
 */
export function walk<T>(root: T, visitor: Visitor): T {
  const path: Array<string | number> = [];

  const visit = (node: unknown, named: boolean, depth: number): unknown => {
    spend();
    if (typeof node !== "object" || node === null) return node;
    if (depth > OUTPUT_LIMITS.depth) throw tooDeep(OUTPUT_LIMITS.depth);

    if (Array.isArray(node)) {
      let copy: unknown[] | undefined;
      for (let i = 0; i < node.length; i++) {
        path.push(i);
        const next = visit(node[i], false, depth + 1);
        path.pop();
        if (next !== node[i]) {
          copy ??= node.slice();
          copy[i] = next;
        }
      }
      return copy ?? node;
    }

    const object = node as JsonObject;
    if (!named && visitor.object) {
      const replaced = visitor.object(object, path, (value) => visit(value, false, depth + 1));
      if (replaced !== undefined) return replaced;
    }

    let copy: JsonObject | undefined;
    for (const key of Object.keys(object)) {
      const value = object[key];
      let next: unknown;
      if (named) {
        path.push(key);
        next = visit(value, false, depth + 1);
        path.pop();
      } else if (isLiteral(key, value)) {
        next = value;
      } else {
        next = visitor.keyword?.(key, value, object);
        if (next === undefined) {
          path.push(key);
          next = visit(value, NAMED.has(key) && isJsonObject(value), depth + 1);
          path.pop();
        }
      }
      if (next !== value) {
        copy ??= { ...object };
        copy[key] = next;
      }
    }
    return copy ?? object;
  };

  return visit(root, false, 1) as T;
}

/** Schema `examples` is a list of literal values; elsewhere it maps names to Example Objects. */
function isLiteral(key: string, value: unknown): boolean {
  return LITERAL.has(key) || (key === "examples" && Array.isArray(value));
}
