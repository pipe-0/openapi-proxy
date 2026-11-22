import { spendText } from "../document/budget.js";
import { pointerSegments, pointerTo, resolvePointer } from "../document/pointer.js";
import { walk } from "../document/walk.js";
import { isJsonObject, type OpenAPIDocument } from "../types.js";

/** A same-document ref that does not go through `components`, e.g. `#/paths/~1users/get/...`. */
function isLooseRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("#/") && !value.startsWith("#/components/");
}

/**
 * Keep a document self-contained when it uses refs that point into places
 * which are no longer there.
 *
 * Bundlers (json-schema-ref-parser, swagger-cli) deduplicate by pointing later
 * occurrences at the first one, wherever that is:
 * `{ "$ref": "#/paths/~1users/get/responses/200/content/application~1json/schema" }`.
 * Removing `GET /users` would leave that ref dangling. This pass finds every
 * ref that resolves in `source` but no longer in `doc`, and replaces it with
 * a copy of its target. Later refs to the same target point at that first
 * copy, which also terminates recursive structures.
 *
 * Returns `doc` itself (same object) when nothing needed to change, which is
 * the case for nearly every document: frameworks only write references to
 * components. Untouched subtrees are shared with the input, never copied.
 *
 * Copying is the one thing here that can make a document grow, and a
 * document can be built so that it grows without end in sight: targets that
 * contain each other, or references that chain so that each copy nests inside
 * the last. The walk pays for everything it looks at and watches its depth
 * (document/walk.ts), and whoever calls this measures what comes out.
 */
export function inlineRemovedRefs(
  doc: OpenAPIDocument,
  source: OpenAPIDocument,
): { doc: OpenAPIDocument; inlined: number } {
  /** Source pointer of an inlined target → pointer of its copy in the output. */
  const copies = new Map<string, string>();
  let inlined = 0;

  /** One spelling per place: `%7E1users` and `~1users` are the same segment. */
  const canonical = (ref: string) => {
    const segments = pointerSegments(ref);
    return segments ? pointerTo(segments) : ref;
  };

  /**
   * Where a ref points now, if its target or something around its target was
   * copied already. Found by shortening the ref one segment at a time, so the
   * cost is the ref's own length however many copies there are.
   */
  const relocated = (spelled: string): string | undefined => {
    if (copies.size === 0) return undefined;
    const ref = canonical(spelled);
    for (let end = ref.length; end > 1; end = ref.lastIndexOf("/", end - 1)) {
      // Each try reads the reference up to here.
      spendText(end);
      const to = copies.get(ref.slice(0, end));
      if (to !== undefined) return to + ref.slice(end);
    }
    return undefined;
  };

  /** One top-level section, walked under its own key so that paths and keywords are right. */
  const section = (key: string) =>
    walk(
      { [key]: doc[key] },
      {
        object(node, path, into) {
          const ref = node.$ref;
          if (!isLooseRef(ref) || resolvePointer(doc, ref) !== undefined) return undefined;

          const moved = relocated(ref);
          if (moved !== undefined) return { ...node, $ref: moved };

          const target = resolvePointer(source, ref);
          // Dangling in the source as well: nothing we can do, leave it as found.
          if (target === undefined) return undefined;

          copies.set(canonical(ref), pointerTo(path));
          inlined += 1;
          // Sibling keys next to `$ref` (summary, description) win over the target's.
          const { $ref: _ref, ...siblings } = node;
          return into(isJsonObject(target) ? { ...target, ...siblings } : target);
        },
      },
    )[key];

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
    const next = section(key);
    if (next !== doc[key]) {
      result ??= { ...doc };
      result[key] = next;
    }
  }
  return { doc: result ?? doc, inlined };
}
