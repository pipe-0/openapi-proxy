import { forEachOperation } from "../document/path-items.js";
import {
  isJsonObject,
  type OpenAPIDocument,
  type OperationEntry,
  type OperationIndex,
  type TagEntry,
} from "../types.js";

/**
 * Build a flat index of every operation in the document, plus tag metadata.
 * Operations are keyed by `"METHOD path"`, which is stable even when the spec
 * has no operationIds. Webhooks are indexed too, keyed `"METHOD webhook:name"`,
 * so they follow the same selection rules as paths. Tag order follows the
 * top-level `tags` array where present, then first appearance on an operation.
 */
export function indexOperations(doc: OpenAPIDocument): OperationIndex {
  const entries: OperationEntry[] = [];

  forEachOperation(doc, ({ key, method, path, webhook, operation }) => {
    const tags = Array.isArray(operation.tags)
      ? operation.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const summary =
      typeof operation.summary === "string"
        ? operation.summary
        : typeof operation.description === "string"
          ? firstLine(operation.description)
          : undefined;

    entries.push({
      key,
      method,
      path,
      tags,
      operationId: typeof operation.operationId === "string" ? operation.operationId : undefined,
      summary,
      deprecated: operation.deprecated === true ? true : undefined,
      webhook: webhook ? true : undefined,
    });
  });

  // Tag metadata: declared tags first (in declared order), then tags only seen on ops.
  const tagMap = new Map<string, TagEntry>();
  if (Array.isArray(doc.tags)) {
    for (const tag of doc.tags) {
      if (!isJsonObject(tag) || typeof tag.name !== "string") continue;
      tagMap.set(tag.name, {
        name: tag.name,
        count: 0,
        description: typeof tag.description === "string" ? tag.description : undefined,
      });
    }
  }
  for (const entry of entries) {
    for (const tag of new Set(entry.tags)) {
      const existing = tagMap.get(tag);
      if (existing) {
        existing.count += 1;
      } else {
        tagMap.set(tag, { name: tag, count: 1 });
      }
    }
  }

  return {
    entries,
    tags: [...tagMap.values()],
    totalOperations: entries.length,
  };
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
