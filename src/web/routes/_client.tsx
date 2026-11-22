import { QueryClientProvider } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setUnauthorizedHandler } from "@/lib/api";
import { queryClient } from "@/lib/query-client";

/**
 * Everything under this layout is the app, and the app is a single-page
 * application: the server sends the document shell, the browser does the rest.
 * Routes below inherit `ssr: false`, so their guards, loaders and components
 * only ever run in the browser.
 */
export const Route = createFileRoute("/_client")({
  ssr: false,
  // Nothing to show while the app's code arrives; an empty page beats a flash of a spinner.
  pendingMinMs: 0,
  pendingComponent: () => <div className="h-svh" />,
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: ClientLayout,
});

function ClientLayout() {
  const router = useRouter();

  // The session can end while the app is open (it expires, or you sign out in
  // another tab). Whichever request notices sends you to sign in, and back.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const { pathname, search } = window.location;
      if (pathname === "/login") return;
      queryClient.clear();
      void router.navigate({ to: "/login", search: { from: pathname + search } });
    });
  }, [router]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={300}>
        <Outlet />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
