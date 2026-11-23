import { createFileRoute } from "@tanstack/react-router";
import { ConnectPage } from "@/pages/connect";

export const Route = createFileRoute("/_client/_app/connect")({
  // `url` is a document handed over from the landing page; `from` opens on one of the two ways.
  validateSearch: (search: Record<string, unknown>): { url?: string; from?: "repository" } => ({
    ...(typeof search.url === "string" ? { url: search.url } : {}),
    ...(search.from === "repository" ? { from: "repository" as const } : {}),
  }),
  component: ConnectPage,
});
