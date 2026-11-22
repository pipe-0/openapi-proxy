import { createFileRoute } from "@tanstack/react-router";
import { LegalView, legalHead, loadLegal } from "@/site/legal";

export const Route = createFileRoute("/_site/about")({
  loader: () => loadLegal("about"),
  head: legalHead,
  component: () => <LegalView page={Route.useLoaderData().page} />,
});
