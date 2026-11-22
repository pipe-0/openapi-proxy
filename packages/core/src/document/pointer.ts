import { isJsonObject } from "../types.js";
import { spend, spendText } from "./budget.js";

/**
 * A reference is gone over several times to be read or written: split, and
 * each of its two kinds of escapes. It is paid for as that many readings.
 */
const PASSES = 4;

/** Escape one key for use as a JSON Pointer segment (RFC 6901). */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * The reference to a place, from the keys (and positions in lists) that lead
 * to it. This is the one spelling a place has: a reference is a URI fragment,
 * so a literal `%` in a key is written `%25` (as `/` is written `~1`),
 * anything that is not printable ASCII is percent-encoded (`«` is `%C2%AB`),
 * and `pointerSegments` reads every spelling back to the same keys.
 */
export function pointerTo(segments: ReadonlyArray<string | number>): string {
  let pointer = "#";
  for (const segment of segments) pointer += `/${fragmentSegment(String(segment))}`;
  spendText(pointer.length * PASSES);
  return pointer;
}

/** One key as it is written in a reference: the pointer's escapes, then the URI's. */
function fragmentSegment(segment: string): string {
  return escapePointerSegment(segment)
    .replace(/%/g, "%25")
    .replace(/[^\u0021-\u007e]/gu, (character) => {
      try {
        return encodeURIComponent(character);
      } catch {
        return character; // half of a surrogate pair: nothing a URI can say
      }
    });
}

/**
 * Split a same-document reference (`"#/components/schemas/Pet"`) into decoded
 * segments. Returns undefined for anything that is not a `#/...` pointer.
 * A bare `"#"` (the document root) yields an empty list.
 */
export function pointerSegments(ref: string): string[] | undefined {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return undefined;
  spendText(ref.length * PASSES);
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
  spend(segments.length);

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
