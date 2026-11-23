import { spend } from "../document/budget.js";
import type { OperationEntry, OperationIndex, Selection, SelectionRules } from "../types.js";

/** Whether an operation is named by one side of a selection: by its key, or by a tag it carries. */
function matcher(rules: SelectionRules | undefined): (entry: OperationEntry) => boolean {
  const keys = new Set(rules?.operations ?? []);
  const tags = new Set(rules?.tags ?? []);
  return (entry) => keys.has(entry.key) || entry.tags.some((tag) => tags.has(tag));
}

/**
 * Resolve a selection against an operation index into the set of operation keys
 * that the output document keeps.
 *
 * An operation is kept when `include` is absent or matches it, and `exclude`
 * does not match it. Tags are rules: they match whatever operations carry the
 * tag right now.
 */
export function resolveSelection(index: OperationIndex, selection: Selection): Set<string> {
  const included = selection.include ? matcher(selection.include) : () => true;
  const excluded = matcher(selection.exclude);

  const kept = new Set<string>();
  for (const entry of index.entries) {
    spend(entry.tags.length + 1);
    if (included(entry) && !excluded(entry)) kept.add(entry.key);
  }
  return kept;
}

/** Derive a URL-safe slug from a human name: `"Public docs"` → `"public-docs"`. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** 2 to 64 characters of a-z, 0-9 and hyphens, starting and ending alphanumeric. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}
