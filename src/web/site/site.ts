/** Facts the landing page and the blog share. */
export const SITE_NAME = "openapi-proxy";
/** Where the code lives. The only place it is written down for the site. */
export const GITHUB_URL = "https://github.com/pipe-0/openapi-proxy";
export const SITE_TITLE = "openapi-proxy: filter, merge and convert OpenAPI documents on the edge";
export const SITE_DESCRIPTION =
  "An open source OpenAPI toolchain on the edge. Filter, merge and convert the OpenAPI documents your backends generate, and serve each result at a stable URL that stays current with your APIs.";

/** What the server knows about this deployment. See site.server.ts. */
export interface SiteInfo {
  /** The origin this page was requested on, for absolute URLs in meta tags. */
  origin: string;
  /** Where "write to us" points. Null leaves the link out. */
  contactEmail: string | null;
}

/**
 * The origin the site layout's loader found, read from a child route's
 * `head()`, which sees every match above it.
 */
export function originOf(
  matches: ReadonlyArray<{ routeId: string; loaderData?: unknown }>,
): string | undefined {
  const data = matches.find((match) => match.routeId === "/_site")?.loaderData as
    | { site?: SiteInfo }
    | undefined;
  return data?.site?.origin;
}

/** Title, description and the social card for one page of the site. */
export function siteHead({
  title,
  description,
  url,
  type = "website",
  image: imagePath = "/site/editor-light.png",
}: {
  title: string;
  description: string;
  /** Absolute URL of the page. */
  url: string;
  type?: "website" | "article";
  /** Path of the social card, if not the editor's screenshot. */
  image?: string;
}) {
  const image = new URL(imagePath, url).href;
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:type", content: type },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: image },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: image },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
