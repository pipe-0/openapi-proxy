import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettingsPage } from "@/pages/project-settings";

export const Route = createFileRoute("/_client/_app/p/$project/settings")({
  component: ProjectSettingsPage,
});
