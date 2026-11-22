import { isJsonObject } from "../types.js";

/** Escape one key for use as a JSON Pointer segment (RFC 6901). */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Split a same-document reference (`"#/components/schemas/Pet"`) into decoded
 * segments. Returns undefined for anything that is not a `#/...` pointer.
 * A bare `"#"` (the document root) yields an empty list.
 */
export function pointerSegments(ref: string): string[] | undefined {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((segment) => unescapePointerSegment(safeDecode(segment)));
}

/** Refs are URI fragments, so `%7B` style escapes are legal; tolerate malformed ones. */
function safeDecode(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Resolve a same-document reference against `root`. Undefined when it does not resolve. */
export function resolvePointer(root: unknown, ref: string): unknown {
  const segments = pointerSegments(ref);
  if (!segments) return undefined;

  let node = root;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      node = node[Number(segment)];
    } else if (isJsonObject(node)) {
      if (!Object.hasOwn(node, segment)) return undefined;
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
}
