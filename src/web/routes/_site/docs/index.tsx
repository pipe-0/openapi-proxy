import { createFileRoute, notFound } from "@tanstack/react-router";
import browserCollections from "collections/browser";
import { DocLayout } from "@/site/doc-page";
import type { DocPage } from "@/site/docs";
import { originOf, siteHead } from "@/site/site";

// The compiled page, preloaded by the loader so the server renders it.
const content = browserCollections.docs.createClientLoader({
  id: "docs",
  component({ default: Mdx }, props: { page: DocPage; pages: DocPage[] }) {
    return <DocLayout Mdx={Mdx} page={props.page} pages={props.pages} />;
  },
});

export const Route = createFileRoute("/_site/docs/")({
  loader: async () => {
    const { listDocs } = await import("@/site/docs");
    const pages = listDocs();
    const page = pages[0];
    if (!page) throw notFound();
    await content.preload(page.path);
    return { page, pages };
  },
  head: ({ loaderData, matches }) => {
    if (!loaderData) return {};
    const { page } = loaderData;
    const origin = originOf(matches);
    const title = `${page.title} · openapi-proxy docs`;
    return origin
      ? siteHead({ title, description: page.description, url: `${origin}/docs` })
      : { meta: [{ title }, { name: "description", content: page.description }] };
  },
  component: Doc,
});

function Doc() {
  const { page, pages } = Route.useLoaderData();
  return content.useContent(page.path, { page, pages });
}
