import { env } from "cloudflare:workers";
import { getRequest } from "@tanstack/react-start/server";
import type { SiteInfo } from "./site";

/** Server only: reads the request and the Worker's variables. */
export function siteInfo(): SiteInfo {
  return {
    origin: new URL(getRequest().url).origin,
    contactEmail: env.CONTACT_EMAIL?.trim() || null,
  };
}
