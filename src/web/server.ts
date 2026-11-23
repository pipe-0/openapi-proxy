import handler from "@tanstack/react-start/server-entry";
import type { Env } from "../server/env";
import api from "../server/index";
import { scheduled } from "../server/scheduled";

/**
 * The Worker. One deployment, five jobs:
 *
 *   /v/*, /api/*   the public documents and the API (Hono, src/server)
 *   cron           the look at the sources that are due, every five minutes
 *   /, /blog, ...  the landing page, pricing, blog, about, terms and privacy, if switched on
 *   /docs          the documentation, rendered here, always (the app links to it)
 *   the rest       the app, which the browser renders; the server sends its shell
 */
const under = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);
/**
 * The pages of a public service: its landing page, pricing, blog, about, terms
 * and privacy, and the files that make them findable (sitemap, robots.txt).
 */
const SITE_PATHS = ["/", "/pricing", "/about", "/terms", "/privacy", "/sitemap.xml", "/robots.txt"];
const isSitePath = (pathname: string) => SITE_PATHS.includes(pathname) || under(pathname, "/blog");
const isDocsPath = (pathname: string) => under(pathname, "/docs");

/**
 * Whether the request carries a session cookie. Its presence is enough to
 * choose between the landing page and the app; the app checks that it is valid.
 */
function hasSessionCookie(request: Request): boolean {
  return /(?:^|;\s*)(?:__Secure-)?openapi-proxy\.session_token=/.test(
    request.headers.get("cookie") ?? "",
  );
}

const toApp = () =>
  new Response(null, {
    status: 302,
    headers: { location: "/app", "cache-control": "no-store", vary: "Cookie" },
  });

export default {
  async fetch(request, env, ctx) {
    const { pathname, hostname } = new URL(request.url);
    if (/^\/(api|v)(\/|$)/.test(pathname)) return api.fetch(request, env, ctx);

    const enabled = env.PUBLIC_SITE === "true";
    const site = isSitePath(pathname);
    if (site) {
      if (pathname === "/" && (!enabled || hasSessionCookie(request))) return toApp();
      if (!enabled) return new Response("Not found", { status: 404 });
    }

    const response = await handler.fetch(request);
    // The landing page, the blog and the docs are meant to be found, on the
    // address a public service is known by. A workers.dev address is where it
    // is tried out, and a private instance's docs are its own business.
    const findable = site || (isDocsPath(pathname) && enabled);
    if (findable && !hostname.endsWith(".workers.dev")) return response;
    // The app is for people who are signed in; none of it belongs in a search index.
    const marked = new Response(response.body, response);
    marked.headers.set("x-robots-tag", "noindex");
    return marked;
  },
  scheduled,
} satisfies ExportedHandler<Env>;
