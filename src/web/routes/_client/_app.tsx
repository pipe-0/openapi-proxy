import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/lib/require-session";

/** The signed-in app: every route below renders inside the sidebar shell. */
export const Route = createFileRoute("/_client/_app")({
  beforeLoad: requireSession,
  component: AppShell,
});
