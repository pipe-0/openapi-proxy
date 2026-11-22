import browserCollections from "collections/browser";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { DocsPageData } from "./docs.server";
import { originOf, siteHead } from "./site";

/**
 * A page of the docs: title, description, the page itself and its table of
 * contents. The compiled MDX is preloaded by the route's loader, so the
 * server renders it.
 */
export const docsContent = browserCollections.docs.createClientLoader({
  id: "docs",
  component({ toc, default: Mdx }, { page }: { page: DocsPageData }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{page.title}</DocsTitle>
        <DocsDescription>{page.description}</DocsDescription>
        <DocsBody>
          <Mdx components={defaultMdxComponents} />
        </DocsBody>
      </DocsPage>
    );
  },
});

/** The head of a docs page. */
export function docsHead(page: DocsPageData | undefined, matches: Parameters<typeof originOf>[0]) {
  if (!page) return {};
  const origin = originOf(matches);
  const title = `${page.title} · openapi-proxy docs`;
  return origin
    ? siteHead({ title, description: page.description, url: `${origin}${page.url}` })
    : { meta: [{ title }, { name: "description", content: page.description }] };
}
