import { createFileRoute } from "@tanstack/react-router";

// A post as plain Markdown: /blog/<slug>.md, next to the page at /blog/<slug>.
export const Route = createFileRoute("/blog/{$slug}.md")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        (await import("@/site/blog-markdown.server")).postMarkdown(
          params.slug,
          new URL(request.url).origin,
        ),
    },
  },
});
