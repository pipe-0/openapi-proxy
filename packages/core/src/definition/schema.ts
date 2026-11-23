import type { JsonObject } from "../types.js";
import { DEFINITION_SHAPE } from "./format.js";
import { schemaOf } from "./shape.js";

/** Where the schema of a version of the format is published. */
export const SCHEMA_URL = "https://openapi-proxy.app/schema/definition.v1.json";

/**
 * The definition format as a JSON Schema, for editors that complete and check
 * YAML as it is typed and for agents that want the format as data. It says
 * what the shape says; what holds between keys (one main source, names of
 * their own) is checked by `readDefinition`.
 */
export function definitionSchema(): JsonObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_URL,
    title: "openapi-proxy definition",
    ...schemaOf(DEFINITION_SHAPE),
  };
}
