import type { OperationEntry, Selection, SelectionMode } from "../types.js";

/**
 * Editing a selection in terms of outcomes.
 *
 * A selection is stored as "what matches" (pinned operations and tag rules)
 * plus a mode that says whether matches are kept or removed. People do not
 * think that way. They think "is this operation served?", and separately
 * "what should happen to operations that show up later?". These helpers let a
 * UI work in those terms: every function takes the desired outcome and returns
 * a new selection that produces it, changing nothing else that is visible.
 */
type Entry = Pick<OperationEntry, "key" | "tags">;

const matches = (operations: Set<string>, tags: Set<string>, entry: Entry): boolean =>
  operations.has(entry.key) || entry.tags.some((tag) => tags.has(tag));

/** Matching an entry means serving it in include mode and hiding it in exclude mode. */
const matchFor = (mode: SelectionMode, served: boolean): boolean => (mode === "include") === served;

function build(mode: SelectionMode, operations: Set<string>, tags: Set<string>): Selection {
  return { mode, operations: [...operations].sort(), tags: [...tags].sort() };
}

/**
 * Apply an edit, then pin whatever the edit unmatched by accident. Dropping a
 * tag rule to unmatch one operation would otherwise unmatch its siblings too.
 */
function edit(
  entries: Entry[],
  selection: Selection,
  targets: Set<string>,
  change: (operations: Set<string>, tags: Set<string>) => void,
): Selection {
  const before = { operations: new Set(selection.operations), tags: new Set(selection.tags) };
  const operations = new Set(selection.operations);
  const tags = new Set(selection.tags);
  change(operations, tags);

  for (const entry of entries) {
    if (targets.has(entry.key)) continue;
    if (matches(before.operations, before.tags, entry) && !matches(operations, tags, entry)) {
      operations.add(entry.key);
    }
  }
  return build(selection.mode, operations, tags);
}

/** Serve or hide specific operations by pinning them. Tag rules that stand in the way are dissolved into pins. */
export function setOperationsServed(
  entries: Entry[],
  selection: Selection,
  keys: Iterable<string>,
  served: boolean,
): Selection {
  const targets = new Set(keys);
  const matched = matchFor(selection.mode, served);
  const affected = entries.filter((entry) => targets.has(entry.key));

  return edit(entries, selection, targets, (operations, tags) => {
    if (matched) {
      for (const entry of affected) {
        if (!matches(operations, tags, entry)) operations.add(entry.key);
      }
      return;
    }
    for (const entry of affected) {
      operations.delete(entry.key);
      for (const tag of entry.tags) tags.delete(tag);
    }
  });
}

/**
 * Serve or hide everything under a tag. Where that lines up with the mode
 * (serving in include mode, hiding in exclude mode) the result is a rule, so
 * operations that later appear under the tag are covered too.
 */
export function setTagServed(
  entries: Entry[],
  selection: Selection,
  tag: string,
  served: boolean,
): Selection {
  const tagged = entries.filter((entry) => entry.tags.includes(tag));
  if (!matchFor(selection.mode, served)) {
    return setOperationsServed(
      entries,
      selection,
      tagged.map((entry) => entry.key),
      served,
    );
  }
  const targets = new Set(tagged.map((entry) => entry.key));
  return edit(entries, selection, targets, (operations, tags) => {
    tags.add(tag);
    // Pins under a rule are redundant.
    for (const key of targets) operations.delete(key);
  });
}

/** Replace a tag rule with pins for the operations it covers today. The outcome stays the same; later additions are no longer covered. */
export function pinTag(entries: Entry[], selection: Selection, tag: string): Selection {
  if (!selection.tags.includes(tag)) return selection;
  return edit(entries, selection, new Set(), (_operations, tags) => {
    tags.delete(tag);
  });
}

/**
 * Switch what happens to operations the source adds later, without changing
 * what is served now. A tag whose operations all match in the new mode becomes
 * a rule, so the tag keeps behaving as a unit.
 */
export function withMode(entries: Entry[], selection: Selection, mode: SelectionMode): Selection {
  if (selection.mode === mode) return selection;

  const operations = new Set(selection.operations);
  const tags = new Set(selection.tags);
  // Flipping the mode flips the meaning of a match, so the matched set inverts.
  const matched = entries.filter((entry) => !matches(operations, tags, entry));
  const matchedKeys = new Set(matched.map((entry) => entry.key));

  const byTag = new Map<string, Entry[]>();
  for (const entry of entries) {
    for (const tag of new Set(entry.tags)) {
      const list = byTag.get(tag);
      if (list) list.push(entry);
      else byTag.set(tag, [entry]);
    }
  }
  const rules = new Set<string>();
  for (const [tag, tagged] of byTag) {
    if (tagged.every((entry) => matchedKeys.has(entry.key))) rules.add(tag);
  }
  const pins = new Set(
    matched.filter((entry) => !entry.tags.some((tag) => rules.has(tag))).map((entry) => entry.key),
  );
  return build(mode, pins, rules);
}
