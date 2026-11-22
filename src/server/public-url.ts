import type { Context } from "hono";
import { appUrl } from "./email";
import type { AppContext } from "./env";

/**
 * Where the documents of a project are served, up to and including the slash
 * before the project's slug: `https://proxy.example.com/v/`.
 *
 * This is the only place that decides it, and the app never builds a public
 * URL itself: the API hands out `urlPrefix` for each project and `url` for
 * each variant. A project served on a domain of its own (see "Custom domains"
 * in ARCHITECTURE.md) then only changes what this returns.
 */
export function urlPrefix(c: Context<AppContext>): string {
  return `${appUrl(c.env, new URL(c.req.url).origin)}/v/`;
}
