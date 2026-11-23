import type { OperationIndex, Selection, SelectionRules, UnmatchedNames } from "../types.js";

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
  const side = (rules: SelectionRules | undefined) => ({
    operations: (rules?.operations ?? []).filter((key) => !keys.has(key)),
    tags: (rules?.tags ?? []).filter((tag) => !tags.has(tag)),
  });
  return { include: side(selection.include), exclude: side(selection.exclude) };
}

/** How many names that is. */
export function unmatchedCount(names: UnmatchedNames): number {
  return (
    names.include.operations.length +
    names.include.tags.length +
    names.exclude.operations.length +
    names.exclude.tags.length
  );
}
