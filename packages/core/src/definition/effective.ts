import type { DocumentOverrides } from "../transforms/override.js";
import type { Selection } from "../types.js";
import type { ProjectDefinition, SourceDefinition, Visibility } from "./format.js";

/**
 * What a variant comes to once everything it leaves unsaid is filled in from
 * the layer above: the project's defaults for title, description and servers,
 * and for who may read it the project's and then the workspace's.
 */

/** Title, description and servers of a variant, key by key over the project's. */
export function effectiveOverrides(
  definition: ProjectDefinition,
  slug: string,
): DocumentOverrides | null {
  const merged = { ...definition.overrides, ...definition.variants[slug]?.overrides };
  return Object.keys(merged).length > 0 ? merged : null;
}

/** What the engine needs to build a variant's document. */
export function effectiveVariant(
  definition: ProjectDefinition,
  slug: string,
): { selection: Selection; overrides: DocumentOverrides | null } {
  const variant = definition.variants[slug];
  return {
    selection: {
      ...(variant?.include ? { include: variant.include } : {}),
      ...(variant?.exclude ? { exclude: variant.exclude } : {}),
    },
    overrides: effectiveOverrides(definition, slug),
  };
}

export interface EffectiveVisibility {
  value: Visibility;
  /** The layer that says so. */
  from: "variant" | "project" | "workspace";
}

/** Who may read a variant, and which layer decides it. */
export function effectiveVisibility(
  definition: ProjectDefinition,
  slug: string,
  workspaceDefault: Visibility,
): EffectiveVisibility {
  const own = definition.variants[slug]?.visibility;
  if (own) return { value: own, from: "variant" };
  if (definition.visibility) return { value: definition.visibility, from: "project" };
  return { value: workspaceDefault, from: "workspace" };
}

/**
 * The sources in the order they are merged: the main one first, then the
 * others as listed. Where two define the same operation, the earlier wins.
 */
export function mergeOrder(definition: ProjectDefinition): SourceDefinition[] {
  const main = definition.sources.find((source) => source.main) ?? definition.sources[0];
  return main ? [main, ...definition.sources.filter((source) => source !== main)] : [];
}

/** The name a project's only, unnamed source goes by. */
export const UNNAMED_SOURCE = "main";

/** What a source is called: its name, or `main` for a project's only one without. */
export function sourceLabel(source: Pick<SourceDefinition, "name">): string {
  return source.name ?? UNNAMED_SOURCE;
}
