import { createFileRoute } from "@tanstack/react-router";
import { ProjectOverviewPage } from "@/pages/project-overview";

export const Route = createFileRoute("/_client/_app/p/$projectId/")({
  component: ProjectOverviewPage,
});
