import { Missing } from "@editor/components/page";
import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { routeTree } from "./routeTree.gen";

/**
 * A fresh nonce for every server render. Start writes a few inline scripts
 * into the page (the state the browser resumes from); the nonce is what lets
 * the Content-Security-Policy allow exactly those and nothing else inline. The
 * root route puts the same value into the response header.
 */
const ssrOptions = createIsomorphicFn().server(() => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return { nonce: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
});

export function getRouter() {
  return createRouter({
    routeTree,
    ssr: ssrOptions(),
    scrollRestoration: true,
    defaultNotFoundComponent: () => (
      <div className="h-svh">
        <Missing what="Page" />
      </div>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
