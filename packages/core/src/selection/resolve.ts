import type { OperationIndex, Selection } from "../types.js";

/**
 * Resolve a selection against an operation index into the set of operation keys
 * that the output document keeps.
 *
 * An operation *matches* the selection iff its key is listed in
 * `selection.operations` OR it carries any tag listed in `selection.tags`
 * (tag rules are dynamic: they match whatever operations carry the tag right now).
 * `include` keeps matches; `exclude` keeps everything else.
 */
export function resolveSelection(index: OperationIndex, selection: Selection): Set<string> {
  const opKeys = new Set(selection.operations);
  const tagRules = new Set(selection.tags);

  const kept = new Set<string>();
  for (const entry of index.entries) {
    const matches = opKeys.has(entry.key) || entry.tags.some((tag) => tagRules.has(tag));
    if (matches === (selection.mode === "include")) {
      kept.add(entry.key);
    }
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
