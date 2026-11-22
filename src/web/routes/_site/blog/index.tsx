import { createFileRoute } from "@tanstack/react-router";
import { BlogIndexView } from "@/site/blog-view";
import { originOf, siteHead } from "@/site/site";

const DESCRIPTION =
  "Common problems with OpenAPI documents, and how to solve them: filtering, merging, converting and serving.";

export const Route = createFileRoute("/_site/blog/")({
  loader: async () => {
    const { listPosts } = await import("@/site/blog");
    return { posts: listPosts() };
  },
  head: ({ matches }) => {
    const origin = originOf(matches);
    const title = "Blog · openapi-proxy";
    if (!origin) return { meta: [{ title }] };
    const head = siteHead({ title, description: DESCRIPTION, url: `${origin}/blog` });
    return {
      ...head,
      links: [
        ...head.links,
        {
          rel: "alternate",
          type: "application/rss+xml",
          title: "openapi-proxy blog",
          href: `${origin}/blog/rss.xml`,
        },
      ],
    };
  },
  component: BlogIndex,
});

function BlogIndex() {
  const { posts } = Route.useLoaderData();
  return <BlogIndexView posts={posts} description={DESCRIPTION} />;
}
