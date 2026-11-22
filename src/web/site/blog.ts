import type browserCollections from "collections/browser";

type Frontmatter = Awaited<
  ReturnType<(typeof browserCollections)["blog"]["raw"][string]>
>["frontmatter"];

export interface Post {
  slug: string;
  url: string;
  /** The file, which keys the compiled post in the collection. */
  path: string;
  title: string;
  description: string;
  /** ISO date, e.g. 2026-11-22. */
  date: string;
  /** Estimated reading time, counted at build time. */
  minutes: number;
  /** Path of the cover under public/, if the post has one. */
  cover: string | null;
  /** The cover cut to 1200 by 630, for link previews. It sits next to the cover as `-og.jpg`. */
  socialImage: string | null;
  featured: boolean;
  draft: boolean;
}

/** Drafts are for writing: visible while developing, absent from a production build. */
const SHOW_DRAFTS = import.meta.env.DEV;

// Only the front matter of every post: enough to list them without loading one.
const files = import.meta.glob<Frontmatter>("./*.mdx", {
  base: "/src/web/content/blog",
  query: { collection: "blog", only: "frontmatter" },
  import: "frontmatter",
  eager: true,
});

const posts: Post[] = Object.entries(files)
  .map(([file, data]) => {
    const path = file.slice("./".length);
    const slug = path.replace(/\.mdx$/, "");
    return {
      slug,
      url: `/blog/${slug}`,
      path,
      title: data.title,
      description: data.description,
      date: new Date(data.date).toISOString().slice(0, 10),
      minutes: data.minutes,
      cover: data.cover ?? null,
      socialImage: data.cover ? data.cover.replace(/\.jpg$/, "-og.jpg") : null,
      featured: data.featured === true,
      draft: data.draft === true,
    };
  })
  .filter((post) => SHOW_DRAFTS || !post.draft)
  .sort((a, b) => b.date.localeCompare(a.date));

/** Posts that may be shown, newest first. */
export const listPosts = (): Post[] => posts;

export const findPost = (slug: string): Post | undefined =>
  posts.find((post) => post.slug === slug);

/** What to read next: the posts around this one, newest first. */
export const relatedPosts = (slug: string, count = 2): Post[] =>
  posts.filter((post) => post.slug !== slug && !post.draft).slice(0, count);

/** "November 22, 2026", the same everywhere a post is dated. */
export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
