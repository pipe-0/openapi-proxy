import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Mark } from "@/components/brand";
import { cn } from "@/lib/utils";
import { formatDay, type Post } from "./blog";
import { GITHUB_URL } from "./site";
import { UrlForm } from "./url-form";

const COVER_WIDTH = 1600;
const COVER_HEIGHT = 678;

/** A post's cover. In dark mode it is dimmed a little, so it does not glare. */
function Cover({
  post,
  className,
  eager = false,
}: {
  post: Post;
  className?: string;
  eager?: boolean;
}) {
  if (!post.cover) return <div className={cn("bg-subtle", className)} aria-hidden />;
  return (
    <img
      src={post.cover}
      alt=""
      width={COVER_WIDTH}
      height={COVER_HEIGHT}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={cn("block bg-subtle object-cover dark:brightness-[0.85]", className)}
    />
  );
}

/** "November 22, 2026 · 5 min read" */
function Dateline({ post, className }: { post: Post; className?: string }) {
  return (
    <p className={cn("text-[13px] text-muted-foreground", className)}>
      <time dateTime={post.date}>{formatDay(post.date)}</time>
      {` · ${post.minutes} min read`}
      {post.draft && " · Draft, not published"}
    </p>
  );
}

function Featured({ post }: { post: Post }) {
  return (
    <Link
      to="/blog/$slug"
      params={{ slug: post.slug }}
      className="group grid items-center gap-8 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:grid-cols-[1.15fr_1fr] lg:gap-12"
    >
      <Cover
        post={post}
        eager
        className="aspect-[2/1] w-full rounded-xl ring-1 ring-border transition-opacity group-hover:opacity-90"
      />
      <div>
        <Dateline post={post} />
        <h2 className="mt-2 font-display text-[26px] leading-[1.18] font-semibold tracking-[-0.02em] text-balance sm:text-[30px]">
          {post.title}
        </h2>
        <p className="mt-3 text-[15.5px] leading-[1.65] text-pretty text-muted-foreground">
          {post.description}
        </p>
      </div>
    </Link>
  );
}

function Card({ post }: { post: Post }) {
  return (
    <Link
      to="/blog/$slug"
      params={{ slug: post.slug }}
      className="group flex flex-col rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Cover
        post={post}
        className="aspect-[2/1] w-full rounded-lg ring-1 ring-border transition-opacity group-hover:opacity-90"
      />
      <h3 className="mt-4 font-display text-[18px] leading-[1.3] font-semibold tracking-[-0.01em] text-pretty">
        {post.title}
      </h3>
      <p className="mt-1.5 line-clamp-2 text-[14px] leading-[1.55] text-muted-foreground">
        {post.description}
      </p>
      <Dateline post={post} className="mt-3" />
    </Link>
  );
}

/** /blog: what the blog is about, the featured post, then every other one. */
export function BlogIndexView({ posts, description }: { posts: Post[]; description: string }) {
  const featured = posts.find((post) => post.featured) ?? posts[0];
  const rest = posts.filter((post) => post !== featured);
  return (
    <div className="mx-auto max-w-6xl px-6 pt-14 sm:pt-20">
      <header className="max-w-2xl">
        <h1 className="font-display text-[38px] leading-[1.1] font-semibold tracking-[-0.03em] sm:text-[44px]">
          Blog
        </h1>
        <p className="mt-3 text-[16px] leading-7 text-pretty text-muted-foreground">
          {description}
        </p>
      </header>

      {featured ? (
        <>
          <div className="mt-12">
            <Featured post={featured} />
          </div>
          {rest.length > 0 && (
            <div className="mt-16 grid gap-x-10 gap-y-14 border-t pt-14 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((post) => (
                <Card key={post.slug} post={post} />
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="mt-14 text-[15px] text-muted-foreground">Nothing published yet.</p>
      )}
    </div>
  );
}

/** One post: header, cover, the text, what to read next, and the way in. */
export function PostView({
  post,
  related,
  children,
}: {
  post: Post;
  related: Post[];
  children: ReactNode;
}) {
  return (
    <>
      <article className="mx-auto max-w-5xl px-6 pt-10 sm:pt-14">
        <Link
          to="/blog"
          className="inline-flex items-center gap-1.5 rounded-sm text-[13.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeftIcon className="size-3.5" />
          All posts
        </Link>
        <header className="mx-auto mt-8 max-w-2xl text-center">
          <Dateline post={post} />
          <h1 className="mt-3 font-display text-[34px] leading-[1.1] font-semibold tracking-[-0.03em] text-balance sm:text-[44px]">
            {post.title}
          </h1>
          <p className="mt-5 text-[17px] leading-[1.6] text-pretty text-muted-foreground sm:text-[18px]">
            {post.description}
          </p>
          <p className="mt-6 flex items-center justify-center gap-2 text-[13.5px] text-muted-foreground">
            <Mark className="size-5" />
            The openapi-proxy team
          </p>
        </header>
        {post.cover && (
          <figure className="mt-10 sm:mt-14">
            <Cover post={post} eager className="h-auto w-full rounded-xl ring-1 ring-border" />
          </figure>
        )}
        <div className="prose-site mx-auto mt-12 max-w-2xl sm:mt-14">{children}</div>

        {related.length > 0 && (
          <footer className="mx-auto mt-20 max-w-2xl border-t pt-10">
            <h2 className="font-display text-[20px] font-semibold tracking-[-0.015em]">
              Keep reading
            </h2>
            <div className="mt-6 grid gap-8 sm:grid-cols-2">
              {related.map((other) => (
                <Card key={other.slug} post={other} />
              ))}
            </div>
          </footer>
        )}
      </article>
      <BlogCta />
    </>
  );
}

/** The end of every post: try it on your own document. */
function BlogCta() {
  return (
    <section className="mx-auto mt-20 max-w-5xl px-6">
      <div className="rounded-2xl bg-subtle px-6 py-12 text-center ring-1 ring-border ring-inset sm:px-10 sm:py-14">
        <h2 className="font-display text-[26px] leading-[1.2] font-semibold tracking-[-0.025em] text-balance sm:text-[30px]">
          Try it on the document you already have.
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-[15px] leading-6 text-pretty text-muted-foreground">
          Paste the URL of your OpenAPI document and pick what each audience sees. Free to start,
          and{" "}
          <a
            href={GITHUB_URL}
            className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            open source
          </a>
          .
        </p>
        <UrlForm id="post-url" className="mx-auto mt-8 max-w-xl" />
      </div>
    </section>
  );
}
