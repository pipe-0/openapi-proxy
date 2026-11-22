import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { Mark } from "@/components/brand";
// For its side effect in the browser: follow the system color scheme while the page is open.
import "@/lib/theme";
import { getDocsShell } from "@/site/docs.functions";

/**
 * The documentation, laid out by Fumadocs UI: the navigation with search on
 * the left, the page in the middle, its contents on the right. Rendered by
 * every instance, because the app links into it.
 */
export const Route = createFileRoute("/docs")({
  loader: () => getDocsShell(),
  component: Layout,
});

function Layout() {
  const { pageTree, site } = useFumadocsLoader(Route.useLoaderData());
  return (
    // The color scheme is the app's own (public/theme.js), so Fumadocs' is off.
    <RootProvider
      theme={{ enabled: false }}
      search={{ options: { type: "static", api: "/docs-search.json" } }}
    >
      <DocsLayout
        tree={pageTree}
        themeSwitch={{ enabled: false }}
        nav={{
          url: "/",
          title: (
            <span className="inline-flex items-center gap-2">
              <Mark className="size-5" />
              <span className="font-medium">openapi-proxy</span>
            </span>
          ),
        }}
        sidebar={{
          // The rest of the site, out of the way of the pages.
          footer: (
            <nav
              aria-label="Elsewhere"
              className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fd-muted-foreground"
            >
              {site && (
                <>
                  <a className="hover:text-fd-foreground" href="/pricing">
                    Pricing
                  </a>
                  <a className="hover:text-fd-foreground" href="/blog">
                    Blog
                  </a>
                </>
              )}
              <a className="hover:text-fd-foreground" href="/app">
                Open the app
              </a>
            </nav>
          ),
        }}
      >
        <Outlet />
      </DocsLayout>
    </RootProvider>
  );
}
