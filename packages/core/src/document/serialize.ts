import { stringify as stringifyYaml } from "yaml";
import type { JsonIndent, OpenAPIDocument, SpecFormat } from "../types.js";

export interface SerializeOptions {
  /**
   * JSON indentation, as for `JSON.stringify`. Defaults to 2. Pass the source's
   * own `ParsedSpec.indent` to mirror it; a minified source then stays minified,
   * which for deeply nested specs is less than half the size of the pretty form.
   * Ignored for YAML.
   */
  indent?: JsonIndent;
}

/**
 * Serialize a document to JSON or YAML.
 *
 * `aliasDuplicateObjects: false` matters: filtered documents share object
 * references with their source (we copy structure, not values), and the YAML
 * serializer would otherwise emit anchors/aliases for them.
 */
export function serialize(
  doc: OpenAPIDocument,
  format: SpecFormat,
  options: SerializeOptions = {},
): string {
  if (format === "json") {
    const indent = options.indent ?? 2;
    const text = JSON.stringify(doc, null, indent);
    return indent === 0 || indent === "" ? text : `${text}\n`;
  }
  return stringifyYaml(doc, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  });
}
