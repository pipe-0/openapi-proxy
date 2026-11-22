import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("@/site/feeds.server")).robotsTxt(new URL(request.url).origin),
    },
  },
});
