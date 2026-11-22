import { createFileRoute, Outlet } from "@tanstack/react-router";
import { getSiteInfo } from "@/site/site.functions";
// For its side effect in the browser: follow the system color scheme while the page is open.
import "@/lib/theme";
import { SiteFooter, SiteHeader } from "@/site/site-shell";

/**
 * The public site: the landing page and the blog, rendered on the server.
 * The Worker only lets requests through to these when PUBLIC_SITE is on
 * (see src/web/server.ts).
 */
export const Route = createFileRoute("/_site")({
  loader: async () => {
    const { listPosts } = await import("@/site/blog");
    return { site: await getSiteInfo(), blog: listPosts().length > 0 };
  },
  component: SiteLayout,
});

function SiteLayout() {
  const { blog } = Route.useLoaderData();
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader blog={blog} />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter blog={blog} />
    </div>
  );
}
