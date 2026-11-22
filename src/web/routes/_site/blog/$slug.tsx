import { createFileRoute, notFound } from "@tanstack/react-router";
import browserCollections from "collections/browser";
import type { MDXProps } from "mdx/types";
import type { FC } from "react";
import type { Post } from "@/site/blog";
import { PostView } from "@/site/blog-view";
import { originOf, SITE_NAME, siteHead } from "@/site/site";

// The compiled post. Preloaded by the loader, so the server renders it and the
// browser has it before it takes over.
const content = browserCollections.blog.createClientLoader({
  id: "blog",
  component({ default: Mdx }: { default: FC<MDXProps> }, props: { post: Post; related: Post[] }) {
    return (
      <PostView post={props.post} related={props.related}>
        <Mdx />
      </PostView>
    );
  },
});

export const Route = createFileRoute("/_site/blog/$slug")({
  loader: async ({ params }) => {
    const { findPost, relatedPosts } = await import("@/site/blog");
    // A draft in a production build is not found here, like any missing post.
    const post = findPost(params.slug);
    if (!post) throw notFound();
    await content.preload(post.path);
    return { post, related: relatedPosts(post.slug) };
  },
  head: ({ loaderData, matches }) => {
    if (!loaderData) return {};
    const { post } = loaderData;
    const origin = originOf(matches);
    const title = `${post.title} · ${SITE_NAME}`;
    if (!origin) {
      return { meta: [{ title }, { name: "description", content: post.description }] };
    }
    const url = `${origin}${post.url}`;
    const head = siteHead({
      title,
      description: post.description,
      url,
      type: "article",
      ...(post.socialImage ? { image: post.socialImage } : {}),
    });
    const structured = (data: object) => ({
      type: "application/ld+json",
      children: JSON.stringify({ "@context": "https://schema.org", ...data }),
    });
    // What search and answer engines read: the post as an article, where it
    // sits on the site, and the questions it answers.
    const article = structured({
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      ...(post.tldr ? { abstract: post.tldr } : {}),
      datePublished: post.date,
      dateModified: post.updated,
      url,
      mainEntityOfPage: url,
      inLanguage: "en",
      ...(post.cover ? { image: new URL(post.cover, origin).href } : {}),
      author: { "@type": "Organization", name: SITE_NAME, url: `${origin}/` },
      publisher: { "@type": "Organization", name: SITE_NAME, url: `${origin}/` },
    });
    const trail = structured({
      "@type": "BreadcrumbList",
      itemListElement: [
        { name: SITE_NAME, item: `${origin}/` },
        { name: "Blog", item: `${origin}/blog` },
        { name: post.title, item: url },
      ].map((crumb, index) => ({ "@type": "ListItem", position: index + 1, ...crumb })),
    });
    const questions = structured({
      "@type": "FAQPage",
      mainEntity: post.faq.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    });
    return {
      ...head,
      meta: [
        ...head.meta,
        { property: "article:published_time", content: post.date },
        { property: "article:modified_time", content: post.updated },
        ...(post.draft ? [{ name: "robots", content: "noindex" }] : []),
      ],
      links: [
        ...head.links,
        // The same post as plain Markdown, for answer engines and agents.
        { rel: "alternate", type: "text/markdown", href: `${url}.md` },
      ],
      scripts: [article, trail, ...(post.faq.length > 0 ? [questions] : [])],
    };
  },
  component: BlogPost,
});

function BlogPost() {
  const { post, related } = Route.useLoaderData();
  return content.useContent(post.path, { post, related });
}
