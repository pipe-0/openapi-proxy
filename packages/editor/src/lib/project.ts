import {
  mergeOrder,
  ORIGINAL_VARIANT,
  type ProjectDefinition,
  type ProjectView,
  type Selection,
  type SourceDefinition,
  type SourceState,
  sourceLabel,
  type VariantDefinition,
  type VariantState,
} from "@openapi-proxy/core";

/** A project as an editor reads it: its definition, and what is known about it. */
export type Project = ProjectView;

/** What a project is called: its name, or its slug. */
export const projectName = (project: Project): string =>
  project.definition.name ?? project.definition.project;
export const projectSlug = (project: Project): string => project.definition.project;

/** One variant of a project: its entry in the definition, and what the service knows about it. */
export interface VariantView {
  slug: string;
  /** What it is called: its name, or its slug. */
  name: string;
  definition: VariantDefinition;
  selection: Selection;
  state: VariantState;
}

export const selectionOf = (variant: VariantDefinition): Selection => ({
  ...(variant.include ? { include: variant.include } : {}),
  ...(variant.exclude ? { exclude: variant.exclude } : {}),
});

/**
 * A project's variants, in the order of the definition: the ones made from
 * its documents. The original, which every project has, is `originalOf`.
 */
export function variantsOf(project: Project): VariantView[] {
  return Object.entries(project.definition.variants).flatMap(([slug, definition]) => {
    if (slug === ORIGINAL_VARIANT) return [];
    const state = project.state.variants[slug];
    return state
      ? [
          {
            slug,
            name: definition.name ?? slug,
            definition,
            selection: selectionOf(definition),
            state,
          },
        ]
      : [];
  });
}

/** The project's documents as they are, which every project serves. Undefined until the service has it. */
export function originalOf(project: Project): VariantView | undefined {
  const state = project.state.variants[ORIGINAL_VARIANT];
  if (!state) return undefined;
  const definition = project.definition.variants[ORIGINAL_VARIANT] ?? {};
  return { slug: ORIGINAL_VARIANT, name: "Original", definition, selection: {}, state };
}

/** One source of a project: its entry in the definition, and what the service knows about it. */
export interface SourceView {
  /** Its name, or "main" for a project's only unnamed source. */
  label: string;
  /** Its place in the definition's list. */
  index: number;
  definition: SourceDefinition;
  state: SourceState;
  /** Whether it is the one that leads the merge. */
  main: boolean;
}

/** A project's sources, in the order of the definition. */
export function sourcesOf(project: Project): SourceView[] {
  const [main] = mergeOrder(project.definition);
  return project.definition.sources.flatMap((definition, index) => {
    const state = project.state.sources[index];
    return state
      ? [{ label: sourceLabel(definition), index, definition, state, main: definition === main }]
      : [];
  });
}

/**
 * In a project of several documents, the name of the one that leads the
 * merge: what the title and servers come from. A project's only document has
 * no name worth saying.
 */
export const mainSourceName = (project: Project): string | undefined => {
  if (project.definition.sources.length < 2) return undefined;
  const [main] = mergeOrder(project.definition);
  return main ? sourceLabel(main) : undefined;
};

/** A definition with one variant put in, replaced or (with `undefined`) taken out, in place. */
export function withVariant(
  definition: ProjectDefinition,
  slug: string,
  variant: VariantDefinition | undefined,
  /** For a variant that changes its slug: the one it had. It keeps its place. */
  previous: string = slug,
): ProjectDefinition {
  const variants: Record<string, VariantDefinition> = {};
  let placed = false;
  for (const [key, existing] of Object.entries(definition.variants)) {
    if (key === previous) {
      if (variant) variants[slug] = variant;
      placed = true;
    } else {
      variants[key] = existing;
    }
  }
  if (!placed && variant) variants[slug] = variant;
  return { ...definition, variants };
}

/** A variant's entry as the app writes it: without keys that say nothing. */
export function variantEntry(
  parts: Omit<VariantDefinition, "include" | "exclude"> & { selection: Selection },
): VariantDefinition {
  const { selection, overrides, ...rest } = parts;
  const entry: VariantDefinition = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null && value !== "") {
      (entry as Record<string, unknown>)[key] = value;
    }
  }
  if (selection.include) entry.include = selection.include;
  if (selection.exclude) entry.exclude = selection.exclude;
  if (overrides && Object.keys(overrides).length > 0) entry.overrides = overrides;
  return entry;
}
