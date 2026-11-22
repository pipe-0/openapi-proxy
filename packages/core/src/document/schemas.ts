import { isJsonObject, type JsonObject, type OpenAPIDocument } from "../types.js";
import { spend } from "./budget.js";
import { isMethodField } from "./path-items.js";

/**
 * Where operations and JSON Schemas live in an OpenAPI document, and schemas
 * inside each other.
 *
 * Neither can be recognised by its shape: a property may be *named*
 * `nullable`, and an example may contain anything at all. So nothing here
 * searches. It follows the structure the specification lays down, from the
 * document to its path items, operations, parameters, bodies and responses,
 * and from each schema to the schemas inside it.
 *
 * (document/walk.ts is the other way of going over a document: everywhere,
 * for what can stand anywhere, such as a reference.)
 */
export interface SchemaVisitor {
  /** Called for every schema that is an object, innermost first. Return it unchanged, or a copy. */
  schema(schema: JsonObject): JsonObject;
  /**
   * Called for a schema that is just `true` or `false`, with the keyword it
   * sits under (`items`, `properties`, ...). Defaults to leaving it alone.
   */
  boolean?(value: boolean, keyword: string): unknown;
}

/** Keywords whose value is one schema. */
const ONE = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
];
/** Keywords whose value is a list of schemas. */
const LIST = ["allOf", "anyOf", "oneOf", "prefixItems"];
/** Keywords whose value maps names to schemas. */
const MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

/** What can be changed in a document by following its structure. */
export interface StructureVisitor extends Partial<SchemaVisitor> {
  /**
   * Called for every operation: under a path, a webhook, a path item among
   * the components, or a callback. Return it unchanged, or a copy.
   */
  operation?(operation: JsonObject): JsonObject;
}

/** A copy of `node` with some of its values replaced. The same object if nothing changed. */
function replace(node: JsonObject, change: (key: string, value: unknown) => unknown): JsonObject {
  let out: JsonObject | undefined;
  const keys = Object.keys(node);
  spend(keys.length);
  for (const key of keys) {
    const value = node[key];
    const next = change(key, value);
    if (next !== value) {
      out ??= { ...node };
      out[key] = next;
    }
  }
  return out ?? node;
}

const each = (value: unknown, change: (item: unknown) => unknown): unknown => {
  if (Array.isArray(value)) {
    spend(value.length);
    let changed = false;
    const next = value.map((item) => {
      const mapped = change(item);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  return isJsonObject(value) ? replace(value, (_key, item) => change(item)) : value;
};

/** One schema and every schema inside it. */
export function mapSchema(schema: unknown, visitor: SchemaVisitor, keyword = ""): unknown {
  spend();
  if (typeof schema === "boolean") return visitor.boolean?.(schema, keyword) ?? schema;
  if (!isJsonObject(schema)) return schema;

  const inner = replace(schema, (key, value) => {
    if (ONE.includes(key)) return mapSchema(value, visitor, key);
    if (LIST.includes(key) || MAP.includes(key)) {
      return each(value, (item) => mapSchema(item, visitor, key));
    }
    return value;
  });
  return visitor.schema(inner);
}

/** A copy of the document with the visitor applied to every schema in it. */
export function mapSchemas(doc: OpenAPIDocument, visitor: SchemaVisitor): OpenAPIDocument {
  return mapStructure(doc, visitor);
}

/** A copy of the document with the visitor applied to every operation and every schema in it. */
export function mapStructure(doc: OpenAPIDocument, visitor: StructureVisitor): OpenAPIDocument {
  const { schema: onSchema, operation: onOperation } = visitor;
  // Without anything to do to schemas, they are not gone into.
  const schema = onSchema
    ? (value: unknown) => mapSchema(value, { ...visitor, schema: onSchema })
    : (value: unknown) => value;
  const map = (value: unknown, change: (item: unknown) => unknown) => each(value, change);
  const object = (value: unknown, change: (key: string, value: unknown) => unknown): unknown =>
    isJsonObject(value) && value.$ref === undefined ? replace(value, change) : value;

  const mediaType = (value: unknown): unknown =>
    object(value, (key, inner) => {
      if (key === "schema" || key === "itemSchema") return schema(inner);
      if (key === "encoding") {
        return map(inner, (encoding) =>
          object(encoding, (field, headers) =>
            field === "headers" ? map(headers, header) : headers,
          ),
        );
      }
      return inner;
    });
  /** Parameters and headers describe a value the same way. */
  const header = (value: unknown): unknown =>
    object(value, (key, inner) => {
      if (key === "schema") return schema(inner);
      if (key === "content") return map(inner, mediaType);
      return inner;
    });
  const body = (value: unknown): unknown =>
    object(value, (key, inner) => (key === "content" ? map(inner, mediaType) : inner));
  const response = (value: unknown): unknown =>
    object(value, (key, inner) => {
      if (key === "headers") return map(inner, header);
      if (key === "content") return map(inner, mediaType);
      return inner;
    });
  const operation = (value: unknown): unknown => {
    const inside = object(value, (key, inner) => {
      if (key === "parameters") return map(inner, header);
      if (key === "requestBody") return body(inner);
      if (key === "responses") return map(inner, response);
      if (key === "callbacks") return map(inner, callback);
      return inner;
    });
    return onOperation && isJsonObject(inside) && inside.$ref === undefined
      ? onOperation(inside)
      : inside;
  };
  const pathItem = (value: unknown): unknown =>
    object(value, (key, inner) => {
      if (key === "parameters") return map(inner, header);
      if (isMethodField(key)) return operation(inner);
      if (key === "additionalOperations") return map(inner, operation);
      return inner;
    });
  const callback = (value: unknown): unknown =>
    object(value, (_expression, item) => pathItem(item));

  // A Map: the names of groups come from the document, and an object would
  // answer to `toString` and `constructor` as well.
  const groups = new Map<string, (value: unknown) => unknown>([
    ["schemas", schema],
    ["parameters", header],
    ["headers", header],
    ["requestBodies", body],
    ["responses", response],
    ["callbacks", callback],
    ["pathItems", pathItem],
    ["mediaTypes", mediaType],
  ]);

  return replace(doc, (key, value) => {
    if (key === "paths" || key === "webhooks" || key === "x-webhooks") return map(value, pathItem);
    if (key === "components" && isJsonObject(value)) {
      return replace(value, (group, members) => {
        const change = groups.get(group);
        return change ? map(members, change) : members;
      });
    }
    return value;
  });
}
