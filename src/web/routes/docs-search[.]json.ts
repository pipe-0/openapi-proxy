import { createFileRoute } from "@tanstack/react-router";

// The search index of the docs, for the search dialog (see docs.server.ts).
export const Route = createFileRoute("/docs-search.json")({
  server: {
    handlers: {
      GET: async () => (await import("@/site/docs.server")).searchIndex(),
    },
  },
});
