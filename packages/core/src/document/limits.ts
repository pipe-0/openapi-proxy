import { isJsonObject } from "../types.js";
import { spend } from "./budget.js";

/**
 * How much a document may hold, measured the way it costs: written out.
 *
 * A document's size in bytes says little about the work it causes. In memory,
 * one object can be mentioned a thousand times and cost nothing: YAML aliases
 * do that on the way in, and transforms do it on the way through (a reference
 * into an operation that is not served is replaced by its target, and the
 * target is not copied but shared). Written out, and for every piece of code
 * that walks the document, each mention is the whole thing again. So a file
 * of a few hundred kilobytes can stand for hundreds of megabytes, and a chain
 * of references can nest far deeper than anything in the file.
 *
 * `measure` therefore walks a document as a serializer would and adds up the
 * bytes it can come to, in JSON or in YAML, whichever is more: indentation,
 * escapes and all. It stops the moment a limit is passed, so its own cost is
 * bounded by the limit, never by the document. test/serialize.test.ts holds
 * `serialize` to the number this gives.
 */
export interface DocumentLimits {
  /** Levels of nesting. */
  depth: number;
  /**
   * Bytes of the document written out one value per line and indented by two
   * spaces a level, which is how JSON and YAML are served. Indentation
   * counts: a deeply nested document is mostly that.
   */
  size: number;
}

/**
 * What is accepted from a source. A real five megabyte document comes to
 * fifteen or twenty written out; one that comes to more is nested like no
 * API description is. Real documents nest a few dozen levels.
 */
export const DOCUMENT_LIMITS: DocumentLimits = { depth: 200, size: 30_000_000 };

/**
 * What a transform may produce, and what is serialized. The same size as a
 * source: merging and selecting make a document smaller or rearrange it, and
 * what inlining and conversion add is small for every document that was not
 * built to grow. The depth leaves room for what they add and stays well
 * inside what serializers recurse through safely.
 */
export const OUTPUT_LIMITS: DocumentLimits = { depth: 400, size: 30_000_000 };

/** A document that is, or became, more than can be worked on. */
export class DocumentTooComplexError extends Error {
  readonly code: "too-deep" | "too-large" | "too-much-work" | "not-plain-data";

  constructor(code: DocumentTooComplexError["code"], message: string) {
    super(message);
    this.name = "DocumentTooComplexError";
    this.code = code;
  }
}

/** The one way of saying that a document nests too deep, whoever notices. */
export function tooDeep(limit: number): DocumentTooComplexError {
  return new DocumentTooComplexError(
    "too-deep",
    `The document is nested more than ${limit} levels deep.`,
  );
}

const notPlain = (what: string) => new DocumentTooComplexError("not-plain-data", what);

/**
 * The bytes `root` comes to written out. Throws a `DocumentTooComplexError`
 * if that, or its depth, is past `limits`.
 *
 * With `plainDataOnly`, also if it holds anything a JSON document cannot: a
 * key called `__proto__` (the one key that is not safe to carry around in
 * JavaScript: reading it from an ordinary object gives the prototype all
 * objects share, and code that writes into what it read changes every object
 * in the program), or a value that is not a plain object, a list, text, a
 * finite number, a boolean or null (YAML can produce sets, dates, byte
 * arrays, symbols and infinities).
 */
export function measure(
  root: unknown,
  limits: DocumentLimits,
  options: { plainDataOnly?: boolean } = {},
): number {
  // Two stacks instead of one of pairs: a large document has millions of values.
  const values: unknown[] = [root];
  const depths: number[] = [1];
  let size = 0;

  while (values.length > 0) {
    const value = values.pop();
    const depth = depths.pop() as number;
    // A line below this value: its indentation, and what separates it from the next.
    const line = 2 * depth + 2;
    spend();

    if (typeof value === "string") {
      size += textSize(value, line);
    } else if (typeof value !== "object" || value === null) {
      if (options.plainDataOnly) assertPlainScalar(value);
      size += String(value).length;
    } else {
      if (depth > limits.depth) throw tooDeep(limits.depth);
      if (Array.isArray(value)) {
        size += 2 + (value.length + 1) * line;
        for (const item of value) {
          values.push(item);
          depths.push(depth + 1);
        }
      } else {
        if (options.plainDataOnly) assertPlainObject(value);
        const keys = Object.keys(value);
        size += 2 + (keys.length + 1) * line;
        for (const key of keys) {
          // `"key": `, or `? "key"` on a line of its own when it is too long to be written before a colon.
          size += textSize(key, line) + 4 + (key.length > LONG_KEY ? line : 0);
          values.push((value as Record<string, unknown>)[key]);
          depths.push(depth + 1);
        }
      }
    }

    if (size > limits.size) {
      throw new DocumentTooComplexError(
        "too-large",
        `The document comes to more than ${Math.round(limits.size / 1_000_000)} MB when it is written out, with everything it repeats and every level it nests.`,
      );
    }
  }
  return size;
}

/** YAML wants a key of more than 1024 characters written in a longer form. */
export const LONG_KEY = 1000;

/**
 * The bytes a text comes to at most. A line break starts a new indented line
 * (in a YAML block), a quote or a backslash is escaped with one more
 * character, and anything that is not printable ASCII is written as up to six
 * (`\u0001` in JSON, or the three bytes of a character in UTF-8).
 */
function textSize(text: string, line: number): number {
  spend(text.length >>> 5);
  let size = 2;
  let lines = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) lines += 1;
    else if (code < 0x20 || code >= 0x7f) size += 6;
    else if (code === 0x22 || code === 0x5c) size += 2;
    else size += 1;
  }
  return lines === 0 ? size : size + (lines + 1) * line;
}

function assertPlainScalar(value: unknown): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  throw notPlain(
    typeof value === "number"
      ? "The document holds a number that JSON cannot express (infinity, or not a number)."
      : "The document holds a value that JSON cannot express.",
  );
}

function assertPlainObject(value: object): void {
  if (!isJsonObject(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw notPlain(
      "The document holds a value that JSON cannot express (a YAML set, date or binary value).",
    );
  }
  if (Object.hasOwn(value, "__proto__")) {
    throw notPlain(
      "The document has a key named `__proto__`, which is not accepted. No OpenAPI document needs one.",
    );
  }
}
