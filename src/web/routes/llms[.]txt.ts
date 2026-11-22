import { createFileRoute } from "@tanstack/react-router";

// What the site is and where its pages are, for language models: https://llmstxt.org
export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("@/site/feeds.server")).llmsTxt(new URL(request.url).origin),
    },
  },
});
