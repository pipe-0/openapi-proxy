import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/blog/rss.xml")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("@/site/feeds.server")).rssXml(new URL(request.url).origin),
    },
  },
});
