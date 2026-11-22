import { createFileRoute } from "@tanstack/react-router";
import { LegalView, legalHead, loadLegal } from "@/site/legal";

export const Route = createFileRoute("/_site/terms")({
  loader: () => loadLegal("terms"),
  head: legalHead,
  component: () => <LegalView page={Route.useLoaderData().page} />,
});
