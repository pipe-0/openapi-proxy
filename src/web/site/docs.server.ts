import { env } from "cloudflare:workers";
import { docs } from "collections/server";
import { createFromSource } from "fumadocs-core/search/server";
import { loader } from "fumadocs-core/source";

/** The documentation as Fumadocs sees it: pages, their URLs, and the tree the sidebar shows. */
export const source = loader(docs.toFumadocsSource(), { baseUrl: "/docs" });

/** What a docs page needs before its content: where it is, and what it is called. */
export interface DocsPageData {
  url: string;
  /** The file, which keys the compiled page in the collection. */
  path: string;
  title: string;
  description: string;
}

/** What the layout around every page needs. */
export async function docsShell() {
  return {
    pageTree: await source.serializePageTree(source.getPageTree()),
    /** Whether this instance has a landing page, pricing and a blog to link to. */
    site: env.PUBLIC_SITE === "true",
  };
}

export function docsPage(slugs: string[]): DocsPageData | undefined {
  const page = source.getPage(slugs);
  if (!page) return undefined;
  return {
    url: page.url,
    path: page.path,
    title: page.data.title,
    description: page.data.description,
  };
}

/** Every page's path, for the sitemap. */
export const docsPaths = (): string[] => source.getPages().map((page) => page.url);

const search = createFromSource(source);

/**
 * The search index, downloaded once by the search dialog and queried in the
 * browser, so that typing does not call the Worker.
 */
export const searchIndex = () => search.staticGET();
