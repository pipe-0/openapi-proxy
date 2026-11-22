export type JsonObject = { [key: string]: unknown };

/** A parsed OpenAPI 3.x document. Treated as plain JSON to preserve key order exactly. */
export type OpenAPIDocument = JsonObject;

/**
 * Bump whenever a change to this package alters the bytes `applyVariant` or
 * `serialize` produce for the same input. Consumers that cache output (the
 * proxy folds this into its ETags) use it to invalidate on upgrade.
 */
export const TRANSFORM_VERSION = 4;

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

export type SelectionMode = "include" | "exclude";

/**
 * A variant's selection. `operations` and `tags` are OR-ed: an operation matches the
 * selection iff its key is listed OR it carries a listed tag. In `include` mode matched
 * operations are kept; in `exclude` mode they are removed.
 */
export interface Selection {
  mode: SelectionMode;
  operations: string[];
  tags: string[];
}

export interface FilterStats {
  keptOperations: number;
  totalOperations: number;
  keptComponents: Record<string, number>;
  totalComponents: Record<string, number>;
  /** Selected operation keys that do not exist in the source (drift, include mode). */
  missingSelectedOperations: string[];
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

/** `JSON.stringify`'s third argument: 0 for minified, a width, or a string such as a tab. */
export type JsonIndent = number | string;

export interface ParsedSpec {
  doc: OpenAPIDocument;
  format: SpecFormat;
  /** Major.minor, e.g. `"3.1"`. */
  specVersion: string;
  /**
   * How the source indents JSON: 0 when it is minified. Pass it to `serialize`
   * so JSON output mirrors the source instead of ballooning a minified
   * document with whitespace. YAML sources report 2.
   */
  indent: JsonIndent;
}

export interface Drift {
  /** Explicitly selected operation keys that no longer exist in the source. */
  missingSelectedOperations: string[];
  /** Tag rules that currently match zero operations. */
  missingSelectedTags: string[];
  /** Operation keys present in the source but absent from the variant's snapshot. */
  newOperations: string[];
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
