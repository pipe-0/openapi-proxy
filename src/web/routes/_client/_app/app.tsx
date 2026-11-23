import { projectSlug } from "@editor/lib/project";
import { Skeleton } from "@editor/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { queries } from "@/lib/api";
import { lastProject } from "@/lib/hooks";

/** `/app` has no content of its own: it opens the project you were last in, or asks for a first one. */
export const Route = createFileRoute("/_client/_app/app")({ component: Home });

function Home() {
  const projects = useQuery(queries.projects);
  if (!projects.data) {
    return (
      <div className="p-8">
        <Skeleton className="h-9 w-64" />
      </div>
    );
  }
  const remembered = lastProject();
  const project =
    projects.data.find((candidate) => projectSlug(candidate) === remembered) ?? projects.data[0];
  return project ? (
    <Navigate to="/p/$project" params={{ project: projectSlug(project) }} replace />
  ) : (
    <Navigate to="/connect" replace />
  );
}
