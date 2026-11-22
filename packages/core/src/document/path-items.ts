import { HTTP_METHODS, isJsonObject, type JsonObject, type OpenAPIDocument } from "../types.js";
import { resolvePointer } from "./pointer.js";

const METHOD_FIELDS = new Set<string>(HTTP_METHODS);

/** Prefix that marks a webhook in an operation key: `"POST webhook:orderShipped"`. */
export const WEBHOOK_PREFIX = "webhook:";

export function isMethodField(key: string): boolean {
  return METHOD_FIELDS.has(key);
}

/** Selection key for a path operation, e.g. `"GET /v1/books"`. */
export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** Selection key for a webhook operation, e.g. `"POST webhook:orderShipped"`. */
export function webhookKey(method: string, name: string): string {
  return `${method.toUpperCase()} ${WEBHOOK_PREFIX}${name}`;
}

export interface PathItemOperation {
  /** Upper-case method as shown to people and used in keys. */
  method: string;
  operation: JsonObject;
}

/**
 * Every operation a path item defines: the fixed method fields plus OpenAPI
 * 3.2's `additionalOperations` map (custom methods such as `COPY`).
 */
export function operationsOf(item: JsonObject): PathItemOperation[] {
  const operations: PathItemOperation[] = [];
  for (const [key, value] of Object.entries(item)) {
    if (METHOD_FIELDS.has(key)) {
      if (isJsonObject(value)) operations.push({ method: key.toUpperCase(), operation: value });
    } else if (key === "additionalOperations" && isJsonObject(value)) {
      for (const [method, operation] of Object.entries(value)) {
        if (isJsonObject(operation)) operations.push({ method: method.toUpperCase(), operation });
      }
    }
  }
  return operations;
}

/**
 * The effective content of a path item. A path item may be a `$ref` to another
 * one (typically `#/components/pathItems/...`); this follows the chain and
 * lays any sibling fields over the target. Returns the item itself when it has
 * no `$ref`, and undefined when the reference cannot be resolved in-document.
 */
export function resolvePathItem(doc: OpenAPIDocument, item: JsonObject): JsonObject | undefined {
  let current = item;
  let merged: JsonObject | undefined;

  for (let hops = 0; hops < 8; hops++) {
    const ref = current.$ref;
    if (typeof ref !== "string") return merged ?? current;

    const target = resolvePointer(doc, ref);
    if (!isJsonObject(target)) return undefined;

    const { $ref: _ref, ...siblings } = merged ?? current;
    merged = { ...target, ...siblings };
    current = target;
  }
  return undefined; // a reference cycle
}

export interface OperationSite {
  key: string;
  method: string;
  /** Path template, or webhook name. */
  path: string;
  webhook: boolean;
  operation: JsonObject;
  /** The path item the operation lives in, with any `$ref` followed. */
  item: JsonObject;
}

/** Walk every operation under `paths` and `webhooks`, in document order. */
export function forEachOperation(doc: OpenAPIDocument, visit: (site: OperationSite) => void): void {
  for (const webhook of [false, true]) {
    const container = webhook ? doc.webhooks : doc.paths;
    if (!isJsonObject(container)) continue;

    for (const [name, rawItem] of Object.entries(container)) {
      if (!isJsonObject(rawItem)) continue;
      const item = resolvePathItem(doc, rawItem);
      if (!item) continue;

      for (const { method, operation } of operationsOf(item)) {
        visit({
          key: webhook ? webhookKey(method, name) : operationKey(method, name),
          method,
          path: name,
          webhook,
          operation,
          item,
        });
      }
    }
  }
}
