export type JsonObject = { [key: string]: unknown };

/** A parsed OpenAPI 3.x document. Treated as plain JSON to preserve key order exactly. */
export type OpenAPIDocument = JsonObject;

/**
 * The version of what this package computes. Bump it with every change that
 * alters what comes out for the same input: the bytes `buildVariant` and
 * `serialize` produce, or the fingerprints of operations. Whoever keeps
 * results (the proxy folds this into its ETags, and fingerprints carry it)
 * uses it to tell which of them an upgrade has made stale.
 */
export const TRANSFORM_VERSION = 6;

/** Operation fields of a Path Item Object. `query` was added in OpenAPI 3.2. */
export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Standard component groups, i.e. the ones that are pruned down to what the
 * kept operations reference. Anything else under `components` (vendor
 * extensions, groups from future spec versions) is copied through untouched.
 */
export const COMPONENT_GROUPS = [
  "schemas",
  "responses",
  "parameters",
  "examples",
  "requestBodies",
  "headers",
  "securitySchemes",
  "links",
  "callbacks",
  "pathItems",
  "mediaTypes",
] as const;

export type ComponentGroup = (typeof COMPONENT_GROUPS)[number];

export interface OperationEntry {
  /**
   * Stable selection key: `"GET /v1/pipes"` for a path operation,
   * `"POST webhook:orderShipped"` for a webhook. Paths are verbatim and
   * case-sensitive.
   */
  key: string;
  method: string;
  /** The path template, or the webhook's name when `webhook` is set. */
  path: string;
  tags: string[];
  operationId?: string | undefined;
  summary?: string | undefined;
  deprecated?: boolean | undefined;
  webhook?: boolean | undefined;
  /** In a document merged from several, the name of the one this operation came from. */
  source?: string | undefined;
  /**
   * Changes when anything a reader would see for this operation changes,
   * including the components it references. Present when the index was built
   * with `fingerprintOperations`; compare, do not interpret.
   */
  fingerprint?: string | undefined;
}

export interface TagEntry {
  name: string;
  count: number;
  description?: string | undefined;
}

export interface OperationIndex {
  entries: OperationEntry[];
  /** Tag order: top-level `tags` array first, then first-seen on operations. Includes counts. */
  tags: TagEntry[];
  totalOperations: number;
}

/** What one side of a selection names: operations by key, and whole tags. */
export interface SelectionRules {
  /** Tags. A tag is a rule: it also covers operations that get the tag later. */
  tags?: string[];
  /** Operation keys, such as `"GET /v1/pipes"`. */
  operations?: string[];
}

/**
 * Which operations a variant serves. An operation matches a side when its key
 * is listed there or it carries a listed tag.
 *
 * It is served when `include` is absent or matches it, and `exclude` does not
 * match it: `exclude` wins. So without `include` everything is served except
 * what is excluded, operations the API adds later too. With `include`, only
 * what it names is served, and an `include` that names nothing serves nothing.
 */
export interface Selection {
  include?: SelectionRules;
  exclude?: SelectionRules;
}

export interface FilterStats {
  keptOperations: number;
  totalOperations: number;
  keptComponents: Record<string, number>;
  totalComponents: Record<string, number>;
  /** Names in the selection that the document has nothing for. */
  unmatched: UnmatchedNames;
  /**
   * `$ref`s that pointed into a removed operation and were replaced by a copy
   * of their target so the output stays self-contained.
   */
  inlinedRefs: number;
}

export interface FilterResult {
  doc: OpenAPIDocument;
  stats: FilterStats;
}

export type SpecFormat = "json" | "yaml";

export interface ParsedSpec {
  doc: OpenAPIDocument;
  format: SpecFormat;
  /** Major.minor, e.g. `"3.1"`. */
  specVersion: string;
  /**
   * Whether the source is JSON on one line. Pass it to `serialize` so that
   * JSON output is minified too, instead of ballooning with whitespace.
   */
  minified: boolean;
}

/** Names in a selection that match nothing in the document, by where they stand. */
export interface UnmatchedNames {
  include: { operations: string[]; tags: string[] };
  exclude: { operations: string[]; tags: string[] };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
