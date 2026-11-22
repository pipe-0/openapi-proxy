import { createFileRoute, redirect } from "@tanstack/react-router";

// A project opens on its documents. Its variants are in the navigation, on every page.
export const Route = createFileRoute("/_client/_app/p/$projectId/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/p/$projectId/settings", params, replace: true });
  },
});
