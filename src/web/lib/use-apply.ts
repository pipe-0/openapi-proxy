import { projectSlug } from "@editor/lib/project";
import type { ApplyRequest, ApplyResult, ProjectDefinition } from "@openapi-proxy/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Project, queries, RequestError } from "@/lib/api";

export type ApplyExtras = Omit<ApplyRequest, "definition" | "ifRevision">;

/** The save of each project that is under way, so that the next one starts when it is done. */
const underWay = new Map<string, Promise<unknown>>();

/**
 * Save a change to a project: its definition, changed, is applied whole. The
 * save says which revision it started from, so two people who save at once
 * do not write over each other: the second is told, and sees the first's
 * change. Afterwards the project is read again and everything on screen
 * follows.
 *
 * Saves of one project from this window go one after the other, each made
 * from the project as it is when its turn comes. Two quick changes (an icon,
 * then a publish) are then two saves, and never one that undoes the other.
 */
export function useApply(project: Project | undefined) {
  const queryClient = useQueryClient();
  const slug = project ? projectSlug(project) : undefined;
  const cached = () =>
    queryClient
      .getQueryData<Project[]>(queries.projects.queryKey)
      ?.find((candidate) => projectSlug(candidate) === slug);
  const replace = (next: Project) =>
    queryClient.setQueryData<Project[]>(queries.projects.queryKey, (current) =>
      current?.some((existing) => projectSlug(existing) === projectSlug(next))
        ? current.map((existing) => (projectSlug(existing) === projectSlug(next) ? next : existing))
        : [...(current ?? []), next],
    );

  return useMutation({
    mutationFn: (
      input:
        | ((definition: ProjectDefinition) => ProjectDefinition)
        | { change: (definition: ProjectDefinition) => ProjectDefinition; more?: ApplyExtras },
    ): Promise<{ result: ApplyResult; project: Project }> => {
      if (slug === undefined) return Promise.reject(new Error("There is no project to change."));
      const { change, more } = typeof input === "function" ? { change: input, more: {} } : input;
      const save = async () => {
        const current = cached() ?? project;
        if (!current) throw new Error("There is no project to change.");
        const result = await api.applyProject({
          definition: change(current.definition),
          ifRevision: current.state.revision,
          ...more,
        });
        const next = await api.getProject(result.project.slug);
        replace(next);
        return { result, project: next };
      };
      const turn = (underWay.get(slug) ?? Promise.resolve()).catch(() => undefined).then(save);
      underWay.set(slug, turn);
      return turn;
    },
    onError: async (error) => {
      // Someone else saved in between. Show what they saved.
      if (error instanceof RequestError && error.code === "conflict") {
        await queryClient.invalidateQueries({ queryKey: queries.projects.queryKey });
      }
    },
  });
}
