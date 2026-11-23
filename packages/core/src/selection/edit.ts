import type { OperationEntry, Selection, SelectionRules } from "../types.js";

/**
 * Editing a selection in terms of outcomes.
 *
 * A selection is stored as rules: what is included, and what is excluded from
 * that. People do not think that way. They think "is this operation served?",
 * and separately "what should happen to operations that show up later?".
 * These helpers let a UI work in those terms: every function takes the
 * desired outcome and returns a new selection that produces it, changing
 * nothing else that is served.
 */
type Entry = Pick<OperationEntry, "key" | "tags">;

/** What happens to operations the API adds after the selection was made. */
export type LaterAdditions = "served" | "hidden";

interface Side {
  operations: Set<string>;
  tags: Set<string>;
}
interface Sides {
  include: Side | undefined;
  exclude: Side;
}

const side = (rules: SelectionRules | undefined): Side => ({
  operations: new Set(rules?.operations ?? []),
  tags: new Set(rules?.tags ?? []),
});
const open = (selection: Selection): Sides => ({
  include: selection.include ? side(selection.include) : undefined,
  exclude: side(selection.exclude),
});

const matches = (rules: Side, entry: Entry): boolean =>
  rules.operations.has(entry.key) || entry.tags.some((tag) => rules.tags.has(tag));
const isServed = (sides: Sides, entry: Entry): boolean =>
  (!sides.include || matches(sides.include, entry)) && !matches(sides.exclude, entry);

function rulesOf(from: Side): SelectionRules {
  const rules: SelectionRules = {};
  if (from.tags.size > 0) rules.tags = [...from.tags].sort();
  if (from.operations.size > 0) rules.operations = [...from.operations].sort();
  return rules;
}

function close(sides: Sides): Selection {
  const selection: Selection = {};
  if (sides.include) selection.include = rulesOf(sides.include);
  if (sides.exclude.tags.size > 0 || sides.exclude.operations.size > 0) {
    selection.exclude = rulesOf(sides.exclude);
  }
  return selection;
}

/**
 * A selection in the one form it is stored and compared in: lists sorted and
 * without duplicates, empty lists left out, and no `exclude` that names
 * nothing. An `include` that names nothing stays: it means "serve nothing".
 */
export function normalizeSelection(selection: Selection): Selection {
  return close(open(selection));
}

/** Pins that say nothing a rule does not already say, for operations the document has. */
function tidy(entries: Entry[], sides: Sides): void {
  for (const entry of entries) {
    const { include, exclude } = sides;
    if (include && entry.tags.some((tag) => include.tags.has(tag))) {
      include.operations.delete(entry.key);
    }
    const reachable = !include || matches(include, entry);
    if (!reachable || entry.tags.some((tag) => exclude.tags.has(tag))) {
      exclude.operations.delete(entry.key);
    }
  }
}

/**
 * Apply an edit, then put back whatever it changed by accident: removing a
 * tag rule to change one operation would otherwise change its siblings too.
 * They are held where they were with a pin of their own.
 */
function edit(
  entries: Entry[],
  selection: Selection,
  targets: Set<string>,
  change: (sides: Sides) => void,
): Selection {
  const before = open(selection);
  const after = open(selection);
  change(after);

  for (const entry of entries) {
    if (targets.has(entry.key)) continue;
    const was = isServed(before, entry);
    const is = isServed(after, entry);
    if (was && !is) after.include?.operations.add(entry.key);
    else if (!was && is) after.exclude.operations.add(entry.key);
  }
  tidy(entries, after);
  return close(after);
}

/** Whether operations the API adds later are served or hidden, tag rules aside. */
export function laterAdditions(selection: Selection): LaterAdditions {
  return selection.include ? "hidden" : "served";
}

/**
 * What a tag's rule says about operations that get the tag later, or
 * undefined if the selection has no rule for the tag.
 */
export function tagRule(selection: Selection, tag: string): LaterAdditions | undefined {
  if (selection.exclude?.tags?.includes(tag)) return "hidden";
  if (selection.include?.tags?.includes(tag)) return "served";
  return undefined;
}

/**
 * Serve or hide specific operations.
 *
 * Hiding an operation that a tag rule serves excludes that one operation and
 * leaves the rule alone, so the tag keeps covering what is added later.
 * Serving an operation that an excluded tag hides is the one case where a
 * rule has to give way, because an exclusion always wins: the tag's other
 * operations stay hidden one by one.
 */
export function setOperationsServed(
  entries: Entry[],
  selection: Selection,
  keys: Iterable<string>,
  served: boolean,
): Selection {
  const targets = new Set(keys);
  const affected = entries.filter((entry) => targets.has(entry.key));

  return edit(entries, selection, targets, (sides) => {
    for (const entry of affected) {
      if (isServed(sides, entry) === served) continue;
      const { include, exclude } = sides;
      if (served) {
        exclude.operations.delete(entry.key);
        for (const tag of entry.tags) exclude.tags.delete(tag);
        if (include && !matches(include, entry)) include.operations.add(entry.key);
        continue;
      }
      const byRule = !include || entry.tags.some((tag) => include.tags.has(tag));
      include?.operations.delete(entry.key);
      if (byRule) exclude.operations.add(entry.key);
    }
  });
}

/**
 * Serve or hide everything under a tag.
 *
 * Where that can be said as a rule it is one, so that operations which later
 * appear under the tag are covered too: serving a tag includes it when later
 * additions are hidden, and hiding a tag excludes it when they are served.
 */
export function setTagServed(
  entries: Entry[],
  selection: Selection,
  tag: string,
  served: boolean,
): Selection {
  const tagged = entries.filter((entry) => entry.tags.includes(tag));
  const targets = new Set(tagged.map((entry) => entry.key));

  return edit(entries, selection, targets, ({ include, exclude }) => {
    if (served) {
      exclude.tags.delete(tag);
      for (const entry of tagged) {
        exclude.operations.delete(entry.key);
        // Hidden through another tag as well: that rule gives way too.
        for (const other of entry.tags) exclude.tags.delete(other);
        include?.operations.delete(entry.key);
      }
      include?.tags.add(tag);
      return;
    }
    if (!include) {
      exclude.tags.add(tag);
      for (const entry of tagged) exclude.operations.delete(entry.key);
      return;
    }
    include.tags.delete(tag);
    for (const entry of tagged) {
      include.operations.delete(entry.key);
      // Still served through another tag it carries.
      if (matches(include, entry)) exclude.operations.add(entry.key);
    }
  });
}

/**
 * Make a tag a rule for what is added to it later, without changing what is
 * served now: when later additions are hidden, the tag's are served from now
 * on, and the other way round. Where that cannot be said, because an
 * exclusion always wins and some of the tag is served, the selection comes
 * back as it is.
 */
export function followTag(entries: Entry[], selection: Selection, tag: string): Selection {
  const sides = open(selection);
  if (!sides.include) {
    const tagged = entries.filter((entry) => entry.tags.includes(tag));
    if (tagged.some((entry) => isServed(sides, entry))) return selection;
  }
  return edit(entries, selection, new Set(), ({ include, exclude }) => {
    if (include) {
      include.tags.add(tag);
      exclude.tags.delete(tag);
    } else {
      exclude.tags.add(tag);
    }
  });
}

/**
 * Replace a tag rule with pins for the operations it covers today. What is
 * served stays the same; operations added under the tag later are no longer
 * covered by it.
 */
export function pinTag(entries: Entry[], selection: Selection, tag: string): Selection {
  if (tagRule(selection, tag) === undefined) return selection;
  return edit(entries, selection, new Set(), ({ include, exclude }) => {
    include?.tags.delete(tag);
    exclude.tags.delete(tag);
  });
}

/**
 * Switch what happens to operations the API adds later, without changing
 * what is served now. A tag whose operations are all served (or all hidden)
 * becomes a rule, so the tag keeps behaving as a unit.
 */
export function withLaterAdditions(
  entries: Entry[],
  selection: Selection,
  later: LaterAdditions,
): Selection {
  if (laterAdditions(selection) === later) return selection;

  const sides = open(selection);
  const served = new Set(
    entries.filter((entry) => isServed(sides, entry)).map((entry) => entry.key),
  );
  const known = new Set(entries.map((entry) => entry.key));
  const byTag = new Map<string, Entry[]>();
  for (const entry of entries) {
    for (const tag of new Set(entry.tags)) {
      const list = byTag.get(tag);
      if (list) list.push(entry);
      else byTag.set(tag, [entry]);
    }
  }
  // Exclusions that are about names the document does not have yet stay as they are.
  const exclude: Side = {
    tags: new Set(sides.exclude.tags),
    operations: new Set([...sides.exclude.operations].filter((key) => !known.has(key))),
  };

  if (later === "served") {
    for (const [tag, tagged] of byTag) {
      if (tagged.every((entry) => !served.has(entry.key))) exclude.tags.add(tag);
    }
    for (const entry of entries) {
      if (!served.has(entry.key) && !matches(exclude, entry)) exclude.operations.add(entry.key);
    }
    return close({ include: undefined, exclude });
  }

  const include: Side = { tags: new Set(), operations: new Set() };
  for (const [tag, tagged] of byTag) {
    if (tagged.every((entry) => served.has(entry.key))) include.tags.add(tag);
  }
  for (const entry of entries) {
    if (served.has(entry.key) && !matches(include, entry)) include.operations.add(entry.key);
  }
  return close({ include, exclude });
}
