import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, type Project, queries, type Variant } from "@/lib/api";

/** "Check now": look at the project's documents at once, and say what came of it. */
export function useCheckProject(project: Project | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.checkProject((project as Project).id),
    onSuccess: (result) => {
      queryClient.setQueryData<Project[]>(queries.projects.queryKey, (current) =>
        current?.map((existing) => (existing.id === result.project.id ? result.project : existing)),
      );
      void queryClient.invalidateQueries({ queryKey: queries.variants.queryKey });
      if (result.project.lastStatus === "error") {
        toast.error(result.project.lastError ?? "The documents could not be checked.");
      } else if (result.changed) {
        toast.success(
          `Updated: ${result.addedOps.length} added, ${result.removedOps.length} removed`,
        );
      } else {
        toast.success("Already up to date");
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
}

/** The project behind the current URL, from the list every screen shares. */
export function useProject(projectId: string | undefined): {
  project: Project | undefined;
  isPending: boolean;
} {
  const projects = useQuery(queries.projects);
  return {
    project: projects.data?.find((candidate) => candidate.id === projectId),
    isPending: projects.isPending,
  };
}

export function useProjectVariants(projectId: string | undefined): {
  variants: Variant[];
  isPending: boolean;
} {
  const variants = useQuery(queries.variants);
  return {
    variants: (variants.data ?? []).filter((variant) => variant.projectId === projectId),
    isPending: variants.isPending,
  };
}

const LAST_PROJECT = "openapi-proxy:project";

export function rememberProject(projectId: string): void {
  try {
    localStorage.setItem(LAST_PROJECT, projectId);
  } catch {
    // No storage: the app opens on the first project instead.
  }
}

export function lastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

/** How a project's source is doing, in one word and one sentence. */
export function sourceStatus(project: Project, now = Date.now()) {
  if (project.lastStatus === "error") {
    return {
      tone: "bad" as const,
      label: "Check failed",
      detail: "The last check of the source failed. The last good copy is being served.",
    };
  }
  // A little more than one interval: the timer comes round every few minutes.
  if (now - project.fetchedAt < project.checkIntervalSeconds * 1000 + 10 * 60_000) {
    return {
      tone: "ok" as const,
      label: "In sync",
      detail: "Checked against the source recently.",
    };
  }
  return {
    tone: "neutral" as const,
    label: "Due",
    detail: "The next check is due. It runs by itself within a few minutes.",
  };
}

/** How many names in this variant's selection the document has nothing for. */
export function notFoundCount(variant: Variant): number {
  const { include, exclude } = variant.notFound;
  return (
    include.operations.length +
    include.tags.length +
    exclude.operations.length +
    exclude.tags.length
  );
}
