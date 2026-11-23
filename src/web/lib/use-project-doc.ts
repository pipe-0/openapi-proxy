import { type ProjectDoc, readProjectDoc } from "@editor/lib/document";
import { projectSlug } from "@editor/lib/project";
import { useQuery } from "@tanstack/react-query";
import { api, type Project } from "@/lib/api";

/** The project's document, fetched once for each state of it and parsed in the browser. */
export function useProjectDoc(project: Project | undefined) {
  const slug = project ? projectSlug(project) : "";
  return useQuery<ProjectDoc>({
    queryKey: ["project-doc", slug, project?.state.documentHash ?? ""],
    queryFn: async () => readProjectDoc(await api.getProjectDocument(slug)),
    enabled: Boolean(project),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });
}
