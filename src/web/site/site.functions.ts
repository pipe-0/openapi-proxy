import { createServerFn } from "@tanstack/react-start";

/**
 * What the pages need from the server. A server function, so it gives the
 * same answer when the page is rendered on the server and when the browser
 * moves between pages of the site.
 */
export const getSiteInfo = createServerFn({ method: "GET" }).handler(async () =>
  (await import("./site.server")).siteInfo(),
);
