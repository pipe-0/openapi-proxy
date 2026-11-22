import { escapePointerSegment, resolvePointer } from "../document/pointer.js";
import { isJsonObject, type JsonObject, type OpenAPIDocument } from "../types.js";

const COMPONENTS_PREFIX = "#/components/";

/** A same-document ref that does not go through `components`, e.g. `#/paths/~1users/get/...`. */
function isLooseRef(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("#/") && !value.startsWith(COMPONENTS_PREFIX)
  );
}

const looseRefCache = new WeakMap<object, boolean>();

/**
 * Whether a document contains any same-document ref outside `components`.
 * Framework-generated specs almost never do, so callers use this to skip the
 * inlining walk entirely. Cached per document object.
 */
export function hasLooseRefs(doc: OpenAPIDocument): boolean {
  const cached = looseRefCache.get(doc);
  if (cached !== undefined) return cached;

  let found = false;
  const stack: unknown[] = [doc];
  while (stack.length > 0 && !found) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (isJsonObject(node)) {
      if (isLooseRef(node.$ref)) found = true;
      for (const value of Object.values(node)) stack.push(value);
    }
  }

  looseRefCache.set(doc, found);
  return found;
}

/**
 * Keep a filtered document self-contained when the source uses refs that point
 * into operations instead of `components`.
 *
 * Bundlers (json-schema-ref-parser, swagger-cli) deduplicate by pointing later
 * occurrences at the first one, wherever that is:
 * `{ "$ref": "#/paths/~1users/get/responses/200/content/application~1json/schema" }`.
 * Removing `GET /users` would leave that ref dangling. This pass finds every
 * ref that resolves in `source` but no longer in `doc`, and replaces it with
 * a copy of its target. Later refs to the same target point at that first
 * copy, which also terminates recursive structures.
 *
 * Returns `doc` itself (same object) when nothing needed to change. Untouched
 * subtrees are shared with the input, never copied.
 */
export function inlineRemovedRefs(
  doc: OpenAPIDocument,
  source: OpenAPIDocument,
): { doc: OpenAPIDocument; inlined: number } {
  /** Source pointer of an inlined target → pointer of its copy in the output. */
  const copies = new Map<string, string>();
  const path: string[] = [];
  let inlined = 0;

  const here = () => `#/${path.map(escapePointerSegment).join("/")}`;

  /**
   * Where a ref points now, if its target or something around its target was
   * copied already. Found by shortening the ref one segment at a time, so the
   * cost is the ref's own length however many copies there are.
   */
  const relocated = (ref: string): string | undefined => {
    for (let end = ref.length; end > 1; end = ref.lastIndexOf("/", end - 1)) {
      const to = copies.get(ref.slice(0, end));
      if (to !== undefined) return to + ref.slice(end);
    }
    return undefined;
  };

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      let copy: unknown[] | undefined;
      for (let i = 0; i < node.length; i++) {
        path.push(String(i));
        const next = visit(node[i]);
        path.pop();
        if (next !== node[i]) {
          copy ??= node.slice();
          copy[i] = next;
        }
      }
      return copy ?? node;
    }
    if (!isJsonObject(node)) return node;

    const ref = node.$ref;
    if (isLooseRef(ref) && resolvePointer(doc, ref) === undefined) {
      const moved = relocated(ref);
      if (moved !== undefined) return { ...node, $ref: moved };

      const target = resolvePointer(source, ref);
      if (target !== undefined) {
        copies.set(ref, here());
        inlined += 1;
        if (!isJsonObject(target)) return target;
        // Sibling keys next to `$ref` (summary, description) win over the target's.
        const { $ref: _ref, ...siblings } = node;
        return visit({ ...target, ...siblings });
      }
      // Dangling in the source as well: nothing we can do, leave it as found.
    }

    let copy: JsonObject | undefined;
    for (const [key, value] of Object.entries(node)) {
      path.push(key);
      const next = visit(value);
      path.pop();
      if (next !== value) {
        copy ??= { ...node };
        copy[key] = next;
      }
    }
    return copy ?? node;
  };

  // Visit what is certain to be served first, so copies land in `paths` rather
  // than in a component that would otherwise have been pruned. The output keeps
  // the document's own key order regardless.
  const keys = Object.keys(doc);
  const order = [
    ...keys.filter((key) => key === "paths" || key === "webhooks"),
    ...keys.filter((key) => key !== "paths" && key !== "webhooks"),
  ];

  let result: OpenAPIDocument | undefined;
  for (const key of order) {
    path.push(key);
    const next = visit(doc[key]);
    path.pop();
    if (next !== doc[key]) {
      result ??= { ...doc };
      result[key] = next;
    }
  }
  return { doc: result ?? doc, inlined };
}
