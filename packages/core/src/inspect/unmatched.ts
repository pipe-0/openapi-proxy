import type { OperationIndex, Selection, UnmatchedNames } from "../types.js";

/**
 * The names in a selection that the document has nothing for: operations it
 * does not define, and tags no operation carries.
 *
 * Nothing is wrong with such a name. A selection is often written before the
 * API it describes is live, and an operation that disappears may come back
 * with the next deploy. What is served simply leaves them out, and whoever
 * owns the selection is told which they are.
 */
export function unmatchedNames(index: OperationIndex, selection: Selection): UnmatchedNames {
  const keys = new Set(index.entries.map((entry) => entry.key));
  const tags = new Set(index.tags.filter((tag) => tag.count > 0).map((tag) => tag.name));
  const side = {
    operations: selection.operations.filter((key) => !keys.has(key)),
    tags: selection.tags.filter((tag) => !tags.has(tag)),
  };
  const none = { operations: [], tags: [] };
  return selection.mode === "include"
    ? { include: side, exclude: none }
    : { include: none, exclude: side };
}
