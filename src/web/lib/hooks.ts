import { useQuery } from "@tanstack/react-query";
import { type Project, queries, type Variant } from "@/lib/api";

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
  if (now - project.fetchedAt < project.ttlSeconds * 1000) {
    return {
      tone: "ok" as const,
      label: "In sync",
      detail: "Checked against the source recently.",
    };
  }
  return {
    tone: "neutral" as const,
    label: "Idle",
    detail: "Will be checked against the source on the next request.",
  };
}

/** Whether the source has moved in a way this variant's owner should look at. */
export function driftOf(variant: Variant): { added: number; missing: number } {
  const { drift } = variant;
  return {
    added: drift.newOperations.length,
    missing:
      drift.missingSelectedOperations.filter((key) => !drift.acknowledged.includes(key)).length +
      drift.missingSelectedTags.length,
  };
}
