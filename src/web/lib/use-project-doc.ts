import { type OpenAPIDocument, parseSpec } from "@openapi-proxy/core";
import { useQuery } from "@tanstack/react-query";
import { api, type Project } from "@/lib/api";
import { projectSlug } from "@/lib/project";
import { byteLength } from "@/lib/utils";

export interface ProjectDoc {
  doc: OpenAPIDocument;
  /** Whether the source is JSON on one line, so previews are sized exactly like what the server sends. */
  minified: boolean;
  bytes: number;
}

/**
 * The project's document, parsed in the browser. The picker and the live
 * preview run the same filter code on it that the server runs, so what the
 * preview shows is what will be served.
 */
export function useProjectDoc(project: Project | undefined) {
  const slug = project ? projectSlug(project) : "";
  return useQuery<ProjectDoc>({
    queryKey: ["project-doc", slug, project?.state.documentHash ?? ""],
    queryFn: async () => {
      const text = await api.getProjectDocument(slug);
      const parsed = parseSpec(text);
      return { doc: parsed.doc, minified: parsed.minified, bytes: byteLength(text) };
    },
    enabled: Boolean(project),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });
}
