import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/api";
import { lastProjectId } from "@/lib/hooks";

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
  const remembered = lastProjectId();
  const project =
    projects.data.find((candidate) => candidate.id === remembered) ?? projects.data[0];
  return project ? (
    <Navigate to="/p/$projectId" params={{ projectId: project.id }} replace />
  ) : (
    <Navigate to="/connect" replace />
  );
}
