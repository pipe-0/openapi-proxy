import { createFileRoute } from "@tanstack/react-router";
import { ProjectOriginalPage } from "@/pages/project-original";

// A project opens on its original: its documents as they are, and every operation in them.
export const Route = createFileRoute("/_client/_app/p/$project/")({
  component: ProjectOriginalPage,
});
