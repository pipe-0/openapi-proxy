import { type Conversion, rewriteKeywords, type SchemaStep, splitAnnotations } from "./step.js";

/**
 * OpenAPI 3.0 to 3.1. From 3.1 on, schemas are plain JSON Schema (2020-12),
 * so the few places where 3.0 had its own dialect are translated. Everything
 * else in a 3.0 document is already valid 3.1 and is left as it is, including
 * `format: binary`, which newer tools still understand.
 *
 * Nothing is lost in this direction.
 */

/** `nullable: true` was 3.0's way to allow null. In JSON Schema, null is a type. */
const nullableBecomesNullType: SchemaStep = {
  name: "nullable becomes the type null",
  apply(schema) {
    if (!("nullable" in schema)) return schema;
    const { nullable, ...rest } = schema;
    if (nullable !== true) return rest;

    if (typeof rest.type === "string") return { ...rest, type: [rest.type, "null"] };
    if (Array.isArray(rest.type)) {
      return rest.type.includes("null") ? rest : { ...rest, type: [...rest.type, "null"] };
    }
    // No type of its own: a reference or a combination. It is that, or null.
    const [annotations, rules] = splitAnnotations(rest);
    if (Object.keys(rules).length === 0) return rest;
    return { ...annotations, anyOf: [rules, { type: "null" }] };
  },
};

/** `minimum: 5, exclusiveMinimum: true` becomes `exclusiveMinimum: 5`. */
const exclusiveBoundsBecomeNumbers: SchemaStep = {
  name: "exclusive bounds become numbers",
  apply(schema) {
    let next = schema;
    for (const [flag, bound] of [
      ["exclusiveMinimum", "minimum"],
      ["exclusiveMaximum", "maximum"],
    ] as const) {
      if (typeof next[flag] !== "boolean") continue;
      const exclusive = next[flag] === true && typeof next[bound] === "number";
      const limit = next[bound];
      next = rewriteKeywords(next, (keyword) => {
        if (keyword === flag) return [];
        if (keyword === bound && exclusive) return [[flag, limit]];
        return undefined;
      });
    }
    return next;
  },
};

/** A schema's single `example` becomes the list `examples`. */
const exampleBecomesExamples: SchemaStep = {
  name: "example becomes examples",
  apply(schema) {
    if (!("example" in schema)) return schema;
    return rewriteKeywords(schema, (keyword, value) => {
      if (keyword !== "example") return undefined;
      return "examples" in schema ? [] : [["examples", [value]]];
    });
  },
};

export const upgrade30to31: Conversion = {
  from: "3.0",
  to: "3.1",
  schemas: [nullableBecomesNullType, exclusiveBoundsBecomeNumbers, exampleBecomesExamples],
  document: [{ name: "version", apply: (doc) => ({ ...doc, openapi: "3.1.0" }) }],
};
