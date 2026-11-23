import { createFileRoute } from "@tanstack/react-router";

// A page of the docs as plain Markdown: /docs/<slug>.md, next to the page at /docs/<slug>.
export const Route = createFileRoute("/docs/{$slug}.md")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        (await import("@/site/docs-markdown.server")).docsMarkdown(
          params.slug,
          new URL(request.url).origin,
        ),
    },
  },
});
