import { createFileRoute } from "@tanstack/react-router";
import { ConnectPage } from "@/pages/connect";

export const Route = createFileRoute("/_client/_app/connect")({
  validateSearch: (search: Record<string, unknown>): { url?: string } =>
    typeof search.url === "string" ? { url: search.url } : {},
  component: ConnectPage,
});
