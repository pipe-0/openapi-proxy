import type { Drift, OperationIndex, Selection } from "../types.js";

/**
 * Compare a variant's selection and its last-reviewed snapshot against the
 * current source index.
 *
 * - `missingSelectedOperations`: explicitly selected keys the source no longer
 *   has. The served output silently drops them (delivery never fails); the UI
 *   surfaces them for review.
 * - `missingSelectedTags`: tag rules that currently match nothing.
 * - `newOperations`: keys the source gained since the snapshot was taken:
 *   relevant in include mode (they stay hidden unless a tag rule covers them)
 *   and in exclude mode (they leak into the output by design).
 */
export function computeDrift(
  selection: Selection,
  snapshot: string[],
  index: OperationIndex,
): Drift {
  const currentKeys = new Set(index.entries.map((entry) => entry.key));
  const currentTags = new Set(index.tags.filter((tag) => tag.count > 0).map((tag) => tag.name));
  const snapshotKeys = new Set(snapshot);

  return {
    missingSelectedOperations: selection.operations.filter((key) => !currentKeys.has(key)),
    missingSelectedTags: selection.tags.filter((tag) => !currentTags.has(tag)),
    newOperations: index.entries.map((entry) => entry.key).filter((key) => !snapshotKeys.has(key)),
  };
}
