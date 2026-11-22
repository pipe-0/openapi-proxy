import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("@/site/feeds.server")).sitemapXml(new URL(request.url).origin),
    },
  },
});
