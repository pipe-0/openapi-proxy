import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePage } from "@/pages/workspace";

export const Route = createFileRoute("/_client/_app/workspace")({ component: WorkspacePage });
