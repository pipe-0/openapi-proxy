import { isJsonObject, type JsonObject } from "../types.js";

/**
 * A small language for saying what a piece of plain data may look like. One
 * description is read three ways: to check a value and say exactly where it
 * is wrong, to emit a JSON Schema for editors and agents, and as the list of
 * keys the written reference has to cover. Having one description is what
 * keeps the three from telling different stories.
 */
export type Shape =
  | { kind: "text"; doc: string; max?: number; pattern?: RegExp; hint?: string }
  | { kind: "flag"; doc: string }
  | { kind: "choice"; doc: string; values: readonly string[] }
  | { kind: "exactly"; doc: string; value: number }
  | { kind: "list"; doc: string; of: Shape; max?: number }
  | {
      kind: "map";
      doc: string;
      of: Shape;
      key: { pattern: RegExp; hint: string };
      max?: number;
      /** Keys that are always there, each with a shape of its own instead of `of`. */
      fixed?: Record<string, Shape>;
    }
  | {
      kind: "object";
      doc: string;
      fields: Record<string, Shape>;
      required?: readonly string[];
      /** What a JSON Schema can say about this object beyond its fields. */
      schema?: JsonObject;
    };

/** Something wrong with a value, at one place in it. */
export interface Problem {
  /** Where: `variants.public.icon`, `sources[1].url`. Empty for the value as a whole. */
  path: string;
  /** What is wrong, as a sentence without the path. */
  message: string;
  /** What would have been right, where that is a short list. */
  allowed?: string[];
}

const at = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

/**
 * Check a value against a shape. Returns the value with text trimmed, or
 * undefined where it does not fit; every misfit is added to `problems`.
 */
export function check(shape: Shape, value: unknown, path: string, problems: Problem[]): unknown {
  const wrong = (message: string, allowed?: string[]): undefined => {
    problems.push(allowed ? { path, message, allowed } : { path, message });
    return undefined;
  };

  switch (shape.kind) {
    case "text": {
      if (typeof value !== "string") return wrong("must be text.");
      const text = value.trim();
      if (text === "") return wrong("must not be empty.");
      if (shape.max !== undefined && text.length > shape.max) {
        return wrong(`must be at most ${shape.max} characters.`);
      }
      if (shape.pattern && !shape.pattern.test(text)) {
        return wrong(shape.hint ?? "does not have the expected form.");
      }
      return text;
    }
    case "flag":
      return typeof value === "boolean" ? value : wrong("must be true or false.");
    case "choice":
      return typeof value === "string" && shape.values.includes(value)
        ? value
        : wrong(`${JSON.stringify(value)} is not one of the choices.`, [...shape.values]);
    case "exactly":
      return value === shape.value ? value : wrong(`must be ${shape.value}.`);
    case "list": {
      if (!Array.isArray(value)) return wrong("must be a list.");
      if (shape.max !== undefined && value.length > shape.max) {
        return wrong(`must have at most ${shape.max.toLocaleString("en-US")} entries.`);
      }
      return value.map((item, index) => check(shape.of, item, `${path}[${index}]`, problems));
    }
    case "map": {
      if (!isJsonObject(value)) return wrong("must be a set of named entries.");
      const keys = Object.keys(value);
      // The fixed keys are there anyway, and take no place of their own.
      const counted = keys.filter((key) => !(shape.fixed && Object.hasOwn(shape.fixed, key)));
      if (shape.max !== undefined && counted.length > shape.max) {
        return wrong(`must have at most ${shape.max} entries.`);
      }
      const out: JsonObject = {};
      for (const key of keys) {
        if (!shape.key.pattern.test(key)) {
          problems.push({ path: at(path, key), message: shape.key.hint });
          continue;
        }
        // Own keys only: a variant may be called "constructor".
        const fixed = shape.fixed && Object.hasOwn(shape.fixed, key) ? shape.fixed[key] : undefined;
        out[key] = check(fixed ?? shape.of, value[key], at(path, key), problems);
      }
      return out;
    }
    case "object": {
      if (!isJsonObject(value)) return wrong("must be a set of keys.");
      const known = Object.keys(shape.fields);
      const out: JsonObject = {};
      for (const key of Object.keys(value)) {
        const field = shape.fields[key];
        if (!field) {
          problems.push({
            path: at(path, key),
            message: "is not a key that exists here.",
            allowed: known,
          });
          continue;
        }
        // A key written with no value says nothing, as in YAML's `name:`.
        if (value[key] === null || value[key] === undefined) continue;
        out[key] = check(field, value[key], at(path, key), problems);
      }
      for (const key of shape.required ?? []) {
        if (!(key in out)) problems.push({ path: at(path, key), message: "is required." });
      }
      return out;
    }
  }
}

/** The same shape as a JSON Schema (draft 2020-12), with its descriptions. */
export function schemaOf(shape: Shape): JsonObject {
  const description = shape.doc;
  switch (shape.kind) {
    case "text":
      return {
        type: "string",
        description,
        minLength: 1,
        ...(shape.max !== undefined ? { maxLength: shape.max } : {}),
        ...(shape.pattern ? { pattern: shape.pattern.source } : {}),
      };
    case "flag":
      return { type: "boolean", description };
    case "choice":
      return { enum: [...shape.values], description };
    case "exactly":
      return { const: shape.value, description };
    case "list":
      return {
        type: "array",
        description,
        items: schemaOf(shape.of),
        ...(shape.max !== undefined ? { maxItems: shape.max } : {}),
      };
    case "map":
      return {
        type: "object",
        description,
        propertyNames: { pattern: shape.key.pattern.source },
        ...(shape.fixed
          ? {
              properties: Object.fromEntries(
                Object.entries(shape.fixed).map(([key, field]) => [key, schemaOf(field)]),
              ),
            }
          : {}),
        additionalProperties: schemaOf(shape.of),
        ...(shape.max !== undefined
          ? { maxProperties: shape.max + Object.keys(shape.fixed ?? {}).length }
          : {}),
      };
    case "object":
      return {
        type: "object",
        description,
        properties: Object.fromEntries(
          Object.entries(shape.fields).map(([key, field]) => [key, schemaOf(field)]),
        ),
        ...(shape.required && shape.required.length > 0 ? { required: [...shape.required] } : {}),
        additionalProperties: false,
        ...shape.schema,
      };
  }
}

/** Every key a shape knows, as paths: `sources[].url`, `variants.<slug>.include.tags`. */
export function keysOf(shape: Shape, path = ""): string[] {
  switch (shape.kind) {
    case "list":
      return keysOf(shape.of, `${path}[]`);
    case "map":
      return [
        ...Object.entries(shape.fixed ?? {}).flatMap(([key, field]) => {
          const here = at(path, key);
          return [here, ...keysOf(field, here)];
        }),
        ...keysOf(shape.of, at(path, "<slug>")),
      ];
    case "object":
      return Object.entries(shape.fields).flatMap(([key, field]) => {
        const here = at(path, key);
        return [here, ...keysOf(field, here)];
      });
    default:
      return [];
  }
}
