import { type UnmatchedNames, unmatchedCount } from "@openapi-proxy/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, type Project, queries } from "@/lib/api";
import { projectSlug } from "@/lib/project";

/** "Check now": look at the documents the service follows at once, and say what came of it. */
export function useCheckProject(project: Project | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.checkProject(projectSlug(project as Project)),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queries.projects.queryKey });
      if (result.lastStatus === "error") {
        toast.error(result.lastError ?? "The documents could not be checked.");
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
export function useProject(slug: string | undefined): {
  project: Project | undefined;
  isPending: boolean;
} {
  const projects = useQuery(queries.projects);
  return {
    project: projects.data?.find((candidate) => projectSlug(candidate) === slug),
    isPending: projects.isPending,
  };
}

const LAST_PROJECT = "openapi-proxy:project";

export function rememberProject(slug: string): void {
  try {
    localStorage.setItem(LAST_PROJECT, slug);
  } catch {
    // No storage: the app opens on the first project instead.
  }
}

export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

/** How keeping a project's followed documents current is going, in one word and one sentence. */
export function checkStatus(check: NonNullable<Project["state"]["check"]>, now = Date.now()) {
  if (check.lastStatus === "error") {
    return {
      tone: "bad" as const,
      label: "Check failed",
      detail: "The last check of the source failed. The last good copy is being served.",
    };
  }
  // A little more than one interval: the timer comes round every few minutes.
  if (
    check.checkedAt !== null &&
    now - check.checkedAt < check.intervalSeconds * 1000 + 10 * 60_000
  ) {
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

/** How many names in a variant's selection the document has nothing for. */
export const notFoundCount = (notFound: UnmatchedNames): number => unmatchedCount(notFound);
