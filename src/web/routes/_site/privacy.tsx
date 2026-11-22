import { createFileRoute } from "@tanstack/react-router";
import { LegalView, legalHead, loadLegal } from "@/site/legal";

export const Route = createFileRoute("/_site/privacy")({
  loader: () => loadLegal("privacy"),
  head: legalHead,
  component: () => <LegalView page={Route.useLoaderData().page} />,
});
