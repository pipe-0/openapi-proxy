import { Document, isMap, isScalar, isSeq, type Node, type Scalar } from "yaml";
import type { ProjectDefinition } from "./format.js";
import { SCHEMA_URL } from "./schema.js";

/**
 * A value of a definition as a YAML node, written the way a person writes
 * one: a few tags on one line, operations (which are long, and can hold
 * braces) on a line each. `key` is the key the value goes under.
 */
export function definitionNode(doc: Document, value: unknown, key?: string | number): Node {
  const node = doc.createNode(value) as Node;
  const dress = (current: unknown, name?: string | number) => {
    if (isSeq(current)) {
      const { items } = current;
      current.flow =
        name === "tags" &&
        items.every(isScalar) &&
        items.reduce((sum, item) => sum + String((item as Scalar).value).length + 2, 0) <= 60;
      for (const item of items) dress(item);
    } else if (isMap(current)) {
      for (const pair of current.items) {
        dress(pair.value, isScalar(pair.key) ? String(pair.key.value) : undefined);
      }
    }
  };
  dress(node, key);
  return node;
}

/**
 * A definition as the text of an `openapi-proxy.yaml`: what "View as file"
 * shows for a project that was made in the app, ready to be saved in a
 * repository and deployed from there.
 */
export function definitionYaml(definition: ProjectDefinition): string {
  const doc = new Document();
  const contents = definitionNode(doc, definition);
  doc.contents = contents as never;
  // Editors that know the schema check the file and complete its keys.
  contents.commentBefore = ` yaml-language-server: $schema=${SCHEMA_URL}`;
  if (isMap(contents)) {
    // A blank line before the two lists that make up most of the file.
    for (const pair of contents.items) {
      if (isScalar(pair.key) && ["sources", "variants"].includes(String(pair.key.value))) {
        pair.key.spaceBefore = true;
      }
    }
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
