import { type OpenAPIDocument, parseSpec } from "@openapi-proxy/core";
import { useQuery } from "@tanstack/react-query";
import { api, type Project } from "@/lib/api";
import { byteLength } from "@/lib/utils";

export interface ProjectDoc {
  doc: OpenAPIDocument;
  /** Whether the source is JSON on one line, so previews are sized exactly like what the server sends. */
  minified: boolean;
  bytes: number;
}

/**
 * The project's source document, parsed in the browser. The picker and the
 * live preview run the same filter code on it that the server runs, so what
 * the preview shows is what will be served.
 */
export function useProjectDoc(project: Pick<Project, "id" | "bodyHash"> | undefined) {
  return useQuery<ProjectDoc>({
    queryKey: ["project-doc", project?.id ?? "", project?.bodyHash ?? ""],
    queryFn: async () => {
      const text = await api.getProjectSpec((project as Project).id);
      const parsed = parseSpec(text);
      return { doc: parsed.doc, minified: parsed.minified, bytes: byteLength(text) };
    },
    enabled: Boolean(project),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });
}
