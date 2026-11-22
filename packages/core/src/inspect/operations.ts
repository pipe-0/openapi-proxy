import { spend, withBudget } from "../document/budget.js";
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
  return withBudget(() => index(doc));
}

function index(doc: OpenAPIDocument): OperationIndex {
  const entries: OperationEntry[] = [];
  const tagMap = new Map<string, TagEntry>();

  // Tag metadata: declared tags first (in declared order), then tags only seen on operations.
  if (Array.isArray(doc.tags)) {
    spend(doc.tags.length);
    for (const tag of doc.tags) {
      if (!isJsonObject(tag) || typeof tag.name !== "string") continue;
      tagMap.set(tag.name, {
        name: tag.name,
        count: 0,
        description: typeof tag.description === "string" ? tag.description : undefined,
      });
    }
  }

  forEachOperation(doc, ({ key, method, path, webhook, operation }) => {
    // Each tag once. The list is the entry's own: an operation that many
    // paths share is paid for at each of them.
    const tags: string[] = [];
    if (Array.isArray(operation.tags)) {
      spend(operation.tags.length);
      for (const tag of new Set(operation.tags)) {
        if (typeof tag !== "string") continue;
        tags.push(tag);
        const known = tagMap.get(tag);
        if (known) known.count += 1;
        else tagMap.set(tag, { name: tag, count: 1 });
      }
    }
    const summary =
      typeof operation.summary === "string"
        ? firstLine(operation.summary)
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

  return {
    entries,
    tags: [...tagMap.values()],
    totalOperations: entries.length,
  };
}

/** The start of a text, for a list: its first line, or 140 characters of it. */
function firstLine(text: string): string {
  // Only the start is read, however long the text is.
  const line = text.slice(0, 1024).trim().split("\n", 1)[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
