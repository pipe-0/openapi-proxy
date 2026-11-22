import {
  type OperationEntry,
  type OperationIndex,
  resolveSelection,
  type Selection,
} from "@openapi-proxy/core";

/** The stored list of a project's operations, in the shape the engine's helpers take. */
export function asIndex(entries: OperationEntry[]): OperationIndex {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of new Set(entry.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return {
    entries,
    tags: [...counts.entries()].map(([name, count]) => ({ name, count })),
    totalOperations: entries.length,
  };
}

/** The keys of the operations a selection serves out of these. */
export function servedKeys(entries: OperationEntry[], selection: Selection): Set<string> {
  return resolveSelection(asIndex(entries), selection);
}
