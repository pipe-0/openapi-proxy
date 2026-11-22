import { HTTP_METHODS, isJsonObject, type JsonObject, type OpenAPIDocument } from "../types.js";
import { spend, spendText } from "./budget.js";
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

/** One operation of a path item, and where in the item it is written. */
export interface PathItemOperation {
  /** Upper-case method as shown to people and used in keys. */
  method: string;
  operation: JsonObject;
  /**
   * The method as the item spells it: the field (`get`), or the key inside
   * OpenAPI 3.2's `additionalOperations` map (custom methods such as `COPY`).
   */
  name: string;
  additional: boolean;
}

/**
 * A path item is two things: operations, and what it says about all of them
 * (parameters, servers, a summary). This is the one place that tells them
 * apart; everything that takes a path item to pieces does it through
 * `operationsOf` and `withOperations`.
 */
export function operationsOf(item: JsonObject): PathItemOperation[] {
  const operations: PathItemOperation[] = [];
  const keys = Object.keys(item);
  spend(keys.length);
  for (const key of keys) {
    const value = item[key];
    if (METHOD_FIELDS.has(key)) {
      if (isJsonObject(value)) {
        operations.push({
          method: key.toUpperCase(),
          operation: value,
          name: key,
          additional: false,
        });
      }
    } else if (key === "additionalOperations" && isJsonObject(value)) {
      const names = Object.keys(value);
      spend(names.length);
      for (const name of names) {
        const operation = value[name];
        if (isJsonObject(operation)) {
          operations.push({ method: name.toUpperCase(), operation, name, additional: true });
        }
      }
    }
  }
  return operations;
}

/**
 * The path item with other operations: what it says about all of them stays,
 * in its place, and `operations` take the place of the ones it had. Without
 * any, what is left is what the item shares.
 */
export function withOperations(
  item: JsonObject,
  operations: ReadonlyArray<Pick<PathItemOperation, "name" | "additional" | "operation">>,
): JsonObject {
  const fields = new Map<string, unknown>();
  const additional = new Map<string, unknown>();
  spend(operations.length);
  for (const { name, operation, additional: custom } of operations) {
    (custom ? additional : fields).set(name, operation);
  }

  // In the item's own order, where it has the method (or the map of custom ones) already.
  const out: JsonObject = {};
  const keys = Object.keys(item);
  spend(keys.length);
  for (const key of keys) {
    if (METHOD_FIELDS.has(key)) {
      if (fields.has(key)) out[key] = fields.get(key);
      fields.delete(key);
    } else if (key === "additionalOperations") {
      if (additional.size > 0) out[key] = Object.fromEntries(additional);
      additional.clear();
    } else {
      out[key] = item[key];
    }
  }
  for (const [name, operation] of fields) out[name] = operation;
  if (additional.size > 0) out.additionalOperations = Object.fromEntries(additional);
  return out;
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
  const seen = new Set<JsonObject>();

  for (;;) {
    const ref = current.$ref;
    if (typeof ref !== "string") return merged ?? current;
    if (seen.has(current)) return undefined; // a reference cycle
    seen.add(current);

    const target = resolvePointer(doc, ref);
    if (!isJsonObject(target)) return undefined;

    // Fields next to the `$ref` lie over the target's. Without any, the target
    // is the item: copying it for every path that points at it would cost
    // paths times fields, on every walk.
    const { $ref: _ref, ...siblings } = merged ?? current;
    if (Object.keys(siblings).length === 0) {
      merged = target;
    } else {
      spend(Object.keys(target).length);
      merged = { ...target, ...siblings };
    }
    current = target;
  }
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

    for (const name of Object.keys(container)) {
      spend();
      const rawItem = container[name];
      if (!isJsonObject(rawItem)) continue;
      const item = resolvePathItem(doc, rawItem);
      if (!item) continue;

      for (const { method, operation } of operationsOf(item)) {
        const key = webhook ? webhookKey(method, name) : operationKey(method, name);
        spendText(key.length);
        visit({ key, method, path: name, webhook, operation, item });
      }
    }
  }
}
