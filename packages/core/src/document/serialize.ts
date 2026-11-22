import type { OpenAPIDocument, SpecFormat } from "../types.js";
import { spendText, withBudget } from "./budget.js";
import { toYaml } from "./yaml.js";

export interface SerializeOptions {
  /**
   * The source's own `ParsedSpec.minified`. JSON from a minified source is
   * written minified, which for deeply nested specs is less than half the
   * size; anything else is written with two spaces a level. Ignored for YAML.
   */
  minified?: boolean;
}

/**
 * Serialize a document to JSON or YAML.
 *
 * Either way it is written out in full: where a document shares one object
 * between several places (transforms copy structure, not values), each place
 * gets all of it, and YAML output has no anchors.
 */
export function serialize(
  doc: OpenAPIDocument,
  format: SpecFormat,
  options: SerializeOptions = {},
): string {
  return withBudget(() => {
    if (format === "yaml") return toYaml(doc);
    const text = options.minified ? JSON.stringify(doc) : `${JSON.stringify(doc, null, 2)}\n`;
    spendText(text.length);
    return text;
  });
}
