import { createFileRoute } from "@tanstack/react-router";

// The whole documentation as one text file, for a language model that wants all of it at once.
export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("@/site/docs-markdown.server")).docsFullText(new URL(request.url).origin),
    },
  },
});
