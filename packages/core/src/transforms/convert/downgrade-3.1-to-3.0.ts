import { resolvePathItem } from "../../document/path-items.js";
import { isJsonObject, type JsonObject } from "../../types.js";
import { type Conversion, type DocumentStep, rewriteKeywords, type SchemaStep } from "./step.js";

/**
 * OpenAPI 3.1 to 3.0, for tools that have not moved on. 3.0 schemas are an
 * older, smaller dialect, so this direction cannot keep everything. What has
 * an equivalent is translated; what has none is removed and reported, so the
 * owner of the document knows exactly what a 3.0 reader will not see.
 *
 * Steps run on a schema after the schemas inside it, so each sees its
 * children already converted.
 */

const isNullOnly = (schema: unknown): boolean =>
  isJsonObject(schema) &&
  (schema.type === "null" ||
    (schema.nullable === true &&
      Array.isArray(schema.enum) &&
      schema.enum.length === 1 &&
      schema.enum[0] === null &&
      Object.keys(schema).length === 2));

/** 3.0 ignores whatever stands next to a `$ref`. Wrapping it in `allOf` keeps both. */
const referenceWithSiblings: SchemaStep = {
  name: "a reference with siblings becomes allOf",
  apply(schema) {
    if (typeof schema.$ref !== "string" || Object.keys(schema).length === 1) return schema;
    return rewriteKeywords(schema, (keyword, value) =>
      keyword === "$ref" ? [["allOf", [{ $ref: value }]]] : undefined,
    );
  },
};

/** `const: x` is `enum: [x]`. */
const constBecomesEnum: SchemaStep = {
  name: "const becomes a one-value enum",
  apply(schema) {
    if (!("const" in schema)) return schema;
    return rewriteKeywords(schema, (keyword, value) =>
      keyword === "const" ? ("enum" in schema ? [] : [["enum", [value]]]) : undefined,
    );
  },
};

/** "This, or null" written as `anyOf` or `oneOf` becomes `nullable: true`. */
const nullBranchBecomesNullable: SchemaStep = {
  name: "a null alternative becomes nullable",
  apply(schema) {
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = schema[keyword];
      if (!Array.isArray(branches) || !branches.some(isNullOnly)) continue;
      const others = branches.filter((branch) => !isNullOnly(branch));
      const [only] = others;

      // One alternative left that brings nothing the schema already says: fold it in.
      const folds =
        others.length === 1 &&
        isJsonObject(only) &&
        only.$ref === undefined &&
        Object.keys(only).every((key) => !(key in schema));
      return rewriteKeywords(schema, (key) => {
        if (key !== keyword) return undefined;
        if (others.length === 0) return [["nullable", true]];
        if (folds) return [...Object.entries(only as JsonObject), ["nullable", true]];
        if (others.length === 1)
          return [
            ["allOf", [only]],
            ["nullable", true],
          ];
        return [
          [keyword, others],
          ["nullable", true],
        ];
      });
    }
    return schema;
  },
};

/** A list of types becomes one type, `nullable`, or a choice between schemas. */
const typeListBecomesOneType: SchemaStep = {
  name: "a list of types becomes one type",
  apply(schema) {
    const { type } = schema;
    if (type !== "null" && !Array.isArray(type)) return schema;
    const types = type === "null" ? ["null"] : type;
    const real = types.filter((name) => name !== "null");
    const nullable: Array<[string, unknown]> = types.includes("null") ? [["nullable", true]] : [];

    return rewriteKeywords(schema, (keyword) => {
      if (keyword !== "type") return undefined;
      if (real.length === 0) return "enum" in schema ? nullable : [["enum", [null]], ...nullable];
      if (real.length === 1) return [["type", real[0]], ...nullable];
      const choice = real.map((name) => ({ type: name }));
      // 3.0 has no way to say "string or number" except as a choice of schemas.
      return "anyOf" in schema
        ? [
            ["allOf", [...(Array.isArray(schema.allOf) ? schema.allOf : []), { anyOf: choice }]],
            ...nullable,
          ]
        : [["anyOf", choice], ...nullable];
    });
  },
};

/** `exclusiveMinimum: 5` becomes `minimum: 5, exclusiveMinimum: true`. */
const exclusiveBoundsBecomeFlags: SchemaStep = {
  name: "exclusive bounds become flags",
  apply(schema) {
    let next = schema;
    for (const [flag, bound, tighter] of [
      ["exclusiveMinimum", "minimum", Math.max],
      ["exclusiveMaximum", "maximum", Math.min],
    ] as const) {
      const exclusive = next[flag];
      if (typeof exclusive !== "number") continue;
      const inclusive = next[bound];
      // Both given: the tighter one is the real limit.
      const wins = typeof inclusive !== "number" || tighter(exclusive, inclusive) === exclusive;
      next = rewriteKeywords(next, (keyword) => {
        if (keyword === bound) return [];
        if (keyword === flag)
          return wins
            ? [
                [bound, exclusive],
                [flag, true],
              ]
            : [[bound, inclusive]];
        return undefined;
      });
    }
    return next;
  },
};

/** The list `examples` becomes the single `example`, its first entry. */
const examplesBecomeExample: SchemaStep = {
  name: "examples becomes example",
  apply(schema, report) {
    if (!Array.isArray(schema.examples)) return schema;
    if (schema.examples.length > 1) report("all but the first example of a schema");
    return rewriteKeywords(schema, (keyword, value) => {
      if (keyword !== "examples") return undefined;
      const examples = value as unknown[];
      return "example" in schema || examples.length === 0 ? [] : [["example", examples[0]]];
    });
  },
};

/** How 3.1 describes files and encoded strings, said the 3.0 way with `format`. */
const contentBecomesFormat: SchemaStep = {
  name: "content keywords become format",
  apply(schema, report) {
    if (
      !("contentMediaType" in schema) &&
      !("contentEncoding" in schema) &&
      !("contentSchema" in schema)
    ) {
      return schema;
    }
    const format =
      schema.contentEncoding === "base64" || schema.contentEncoding === "base64url"
        ? "byte"
        : schema.contentMediaType === "application/octet-stream"
          ? "binary"
          : undefined;
    if (!format) report("the media type of a string's content");
    let placed = "format" in schema || !format;
    return rewriteKeywords(schema, (keyword) => {
      if (!["contentMediaType", "contentEncoding", "contentSchema"].includes(keyword))
        return undefined;
      if (placed) return [];
      placed = true;
      return [["format", format]];
    });
  },
};

/** Keywords of JSON Schema 2020-12 that 3.0 has no word for. */
const NOT_IN_3_0: Record<string, string | undefined> = {
  $schema: undefined,
  $id: undefined,
  $anchor: undefined,
  $comment: undefined,
  $vocabulary: undefined,
  $dynamicAnchor: undefined,
  $dynamicRef: "dynamic references",
  $defs: "definitions local to a schema ($defs)",
  definitions: "definitions local to a schema",
  patternProperties: "properties matched by pattern (patternProperties)",
  propertyNames: "rules for property names (propertyNames)",
  unevaluatedProperties: "unevaluatedProperties",
  unevaluatedItems: "unevaluatedItems",
  prefixItems: "tuples (prefixItems)",
  contains: "contains",
  minContains: "contains",
  maxContains: "contains",
  if: "conditions (if, then, else)",
  // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, in a table of keywords
  then: undefined,
  else: undefined,
  dependentSchemas: "dependent schemas",
  dependentRequired: "dependent required properties",
};

const keywordsWithoutEquivalent: SchemaStep = {
  name: "keywords 3.0 does not have are removed",
  apply(schema, report) {
    if (!Object.keys(schema).some((keyword) => keyword in NOT_IN_3_0)) return schema;
    return rewriteKeywords(schema, (keyword) => {
      if (!(keyword in NOT_IN_3_0)) return undefined;
      const loss = NOT_IN_3_0[keyword];
      if (loss) report(loss);
      return [];
    });
  },
};

/** In 3.0 an array has to say what its items are. */
const arraysNameTheirItems: SchemaStep = {
  name: "arrays without items get items: {}",
  apply(schema) {
    return schema.type === "array" && !("items" in schema) ? { ...schema, items: {} } : schema;
  },
};

// ---- The document around the schemas ----

/** 3.0 has no `webhooks`. Redoc and others read them from `x-webhooks`. */
const webhooksBecomeExtension: DocumentStep = {
  name: "webhooks move to x-webhooks",
  apply(doc, report) {
    if (doc.webhooks === undefined) return doc;
    const empty = !isJsonObject(doc.webhooks) || Object.keys(doc.webhooks).length === 0;
    if (!empty) report("webhooks as a standard section (they are kept under x-webhooks)");
    return Object.fromEntries(
      Object.entries(doc).flatMap(([key, value]) => {
        if (key !== "webhooks") return [[key, value]];
        return empty ? [] : [["x-webhooks", value]];
      }),
    );
  },
};

/** `components.pathItems` does not exist in 3.0: each use gets a copy. */
const pathItemsAreInlined: DocumentStep = {
  name: "referenced path items are inlined",
  apply(doc) {
    const components = doc.components;
    if (!isJsonObject(components) || components.pathItems === undefined) return doc;
    const inline = (container: unknown): unknown => {
      if (!isJsonObject(container)) return container;
      return Object.fromEntries(
        Object.entries(container).map(([name, item]) => [
          name,
          isJsonObject(item) && typeof item.$ref === "string"
            ? (resolvePathItem(doc, item) ?? item)
            : item,
        ]),
      );
    };
    const { pathItems: _removed, ...rest } = components;
    const next: JsonObject = { ...doc, components: rest };
    if (doc.paths !== undefined) next.paths = inline(doc.paths);
    if (doc["x-webhooks"] !== undefined) next["x-webhooks"] = inline(doc["x-webhooks"]);
    if (Object.keys(rest).length === 0) delete next.components;
    return next;
  },
};

/** Mutual TLS as a security scheme is new in 3.1. */
const mutualTlsIsRemoved: DocumentStep = {
  name: "mutualTLS security schemes are removed",
  apply(doc, report) {
    const components = doc.components;
    const schemes = isJsonObject(components) ? components.securitySchemes : undefined;
    if (!isJsonObject(schemes)) return doc;
    const gone = Object.entries(schemes)
      .filter(([, scheme]) => isJsonObject(scheme) && scheme.type === "mutualTLS")
      .map(([name]) => name);
    if (gone.length === 0) return doc;
    report("mutual TLS security schemes");

    const without = (requirements: unknown): unknown =>
      Array.isArray(requirements)
        ? requirements.filter(
            (requirement) =>
              !isJsonObject(requirement) || !gone.some((name) => name in requirement),
          )
        : requirements;
    const strip = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(strip);
      if (!isJsonObject(node)) return node;
      return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [
          key,
          key === "security" ? without(value) : strip(value),
        ]),
      );
    };
    const kept = Object.fromEntries(
      Object.entries(schemes).filter(([name]) => !gone.includes(name)),
    );
    return {
      ...(strip(doc) as JsonObject),
      components: { ...(strip(components) as JsonObject), securitySchemes: kept },
    };
  },
};

/** Small things at the top of the document that 3.0 does not know. */
const topLevelTidied: DocumentStep = {
  name: "top-level fields 3.0 lacks are removed, and paths is present",
  apply(doc) {
    const next: JsonObject = { ...doc, openapi: "3.0.3" };
    delete next.jsonSchemaDialect;
    if (isJsonObject(next.info)) {
      const { summary, ...info } = next.info;
      // A summary is better kept as the description than lost.
      if (typeof summary === "string" && info.description === undefined) info.description = summary;
      if (isJsonObject(info.license)) {
        const { identifier: _identifier, ...license } = info.license;
        info.license = license;
      }
      next.info = info;
    }
    if (next.paths === undefined) next.paths = {};
    return next;
  },
};

export const downgrade31to30: Conversion = {
  from: "3.1",
  to: "3.0",
  schemas: [
    referenceWithSiblings,
    constBecomesEnum,
    typeListBecomesOneType,
    nullBranchBecomesNullable,
    exclusiveBoundsBecomeFlags,
    examplesBecomeExample,
    contentBecomesFormat,
    keywordsWithoutEquivalent,
    arraysNameTheirItems,
  ],
  document: [webhooksBecomeExtension, pathItemsAreInlined, mutualTlsIsRemoved, topLevelTidied],
};

/** `true` allows anything and `false` nothing; 3.0 wants both spelled out, except where it accepts a boolean. */
export function booleanSchemaIn30(value: boolean, keyword: string): unknown {
  if (keyword === "additionalProperties") return value;
  return value ? {} : { not: {} };
}
