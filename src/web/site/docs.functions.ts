import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

/**
 * What the docs pages need from the server. Server functions, so they give
 * the same answer when a page is rendered on the server and when the browser
 * moves between pages.
 */
export const getDocsShell = createServerFn({ method: "GET" }).handler(async () =>
  (await import("./docs.server")).docsShell(),
);

export const getDocsPage = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data }) => {
    const page = (await import("./docs.server")).docsPage(data);
    if (!page) throw notFound();
    return page;
  });
