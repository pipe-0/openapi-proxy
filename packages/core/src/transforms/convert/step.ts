import type { JsonObject, OpenAPIDocument } from "../../types.js";

/**
 * A conversion between two versions of OpenAPI is a list of steps. Each step
 * does one thing, has a name that says what, and can be read and tested on
 * its own. Adding support for one more difference between two versions means
 * adding one step.
 */

/** Says that something could not be carried over, in words a reader understands. */
export type Report = (what: string) => void;

/** One change applied to every schema of a document. */
export interface SchemaStep {
  name: string;
  apply(schema: JsonObject, report: Report): JsonObject;
}

/** One change to the document as a whole. */
export interface DocumentStep {
  name: string;
  apply(doc: OpenAPIDocument, report: Report): OpenAPIDocument;
}

export interface Conversion {
  from: string;
  to: string;
  /** Run on each schema in this order, innermost schemas first. */
  schemas: SchemaStep[];
  /** Run once each, in this order, after the schemas. */
  document: DocumentStep[];
}

/**
 * A schema with some keywords removed, renamed or given another value, the
 * others in their old order. `change` returns the entries that take a
 * keyword's place: none to drop it, one to keep or replace it, several to
 * split it.
 */
export function rewriteKeywords(
  schema: JsonObject,
  change: (keyword: string, value: unknown) => Array<[string, unknown]> | undefined,
): JsonObject {
  let changed = false;
  const entries: Array<[string, unknown]> = [];
  for (const [keyword, value] of Object.entries(schema)) {
    const next = change(keyword, value);
    if (next === undefined) {
      entries.push([keyword, value]);
    } else {
      changed = true;
      entries.push(...next);
    }
  }
  return changed ? Object.fromEntries(entries) : schema;
}

/** Keywords that describe a schema without constraining what is valid. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "externalDocs",
  "xml",
]);

/** A schema's annotations (and extensions) apart from the keywords that constrain. */
export function splitAnnotations(schema: JsonObject): [annotations: JsonObject, rules: JsonObject] {
  const annotations: JsonObject = {};
  const rules: JsonObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword) || keyword.startsWith("x-")) annotations[keyword] = value;
    else rules[keyword] = value;
  }
  return [annotations, rules];
}
