import { createFileRoute } from "@tanstack/react-router";
import { getDocsPage } from "@/site/docs.functions";
import { docsContent, docsHead } from "@/site/docs-page";

export const Route = createFileRoute("/docs/$slug")({
  loader: async ({ params }) => {
    const page = await getDocsPage({ data: [params.slug] });
    await docsContent.preload(page.path);
    return page;
  },
  head: ({ loaderData, matches }) => docsHead(loaderData, matches),
  component: Page,
});

function Page() {
  const page = Route.useLoaderData();
  return docsContent.useContent(page.path, { page });
}
