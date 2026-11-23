import {
  type ApplyRequest,
  type ApplyResult,
  mergeOrder,
  type ProjectDefinition,
  type Selection,
  type SourceDefinition,
  type SourceState,
  sourceLabel,
  type VariantDefinition,
  type VariantState,
} from "@openapi-proxy/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, type Project, queries, RequestError } from "@/lib/api";

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

/** A project's variants, in the order of the definition. */
export function variantsOf(project: Project): VariantView[] {
  return Object.entries(project.definition.variants).flatMap(([slug, definition]) => {
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

/** The name of the source that leads the merge: what the document's title and servers come from. */
export const mainSourceName = (project: Project): string | undefined => {
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

export type ApplyExtras = Omit<ApplyRequest, "definition" | "ifRevision">;

/**
 * Save a change to a project: its definition, changed, is applied whole. The
 * save says which revision it started from, so two people who save at once
 * do not write over each other: the second is told, and sees the first's
 * change. Afterwards the project is read again and everything on screen
 * follows.
 */
export function useApply(project: Project | undefined) {
  const queryClient = useQueryClient();
  const replace = (next: Project) =>
    queryClient.setQueryData<Project[]>(queries.projects.queryKey, (current) =>
      current?.some((existing) => projectSlug(existing) === projectSlug(next))
        ? current.map((existing) => (projectSlug(existing) === projectSlug(next) ? next : existing))
        : [...(current ?? []), next],
    );

  return useMutation({
    mutationFn: async (
      input:
        | ((definition: ProjectDefinition) => ProjectDefinition)
        | { change: (definition: ProjectDefinition) => ProjectDefinition; more?: ApplyExtras },
    ): Promise<{ result: ApplyResult; project: Project }> => {
      if (!project) throw new Error("There is no project to change.");
      const { change, more } = typeof input === "function" ? { change: input, more: {} } : input;
      const result = await api.applyProject({
        definition: change(project.definition),
        ifRevision: project.state.revision,
        ...more,
      });
      const next = await api.getProject(result.project.slug);
      replace(next);
      return { result, project: next };
    },
    onError: async (error) => {
      // Someone else saved in between. Show what they saved.
      if (error instanceof RequestError && error.code === "conflict") {
        await queryClient.invalidateQueries({ queryKey: queries.projects.queryKey });
      }
    },
  });
}

/** Say why a save did not go through, unless the screen shows it some other way. */
export const toastError = (error: unknown) => toast.error(errorMessage(error));
