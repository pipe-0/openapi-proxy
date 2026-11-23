import { createFileRoute, redirect } from "@tanstack/react-router";

// A project opens on its documents. Its variants are in the navigation, on every page.
export const Route = createFileRoute("/_client/_app/p/$project/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/p/$project/settings", params, replace: true });
  },
});
