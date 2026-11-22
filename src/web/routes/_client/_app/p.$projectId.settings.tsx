import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettingsPage } from "@/pages/project-settings";

export const Route = createFileRoute("/_client/_app/p/$projectId/settings")({
  component: ProjectSettingsPage,
});
