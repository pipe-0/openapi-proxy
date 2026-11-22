import type browserCollections from "collections/browser";

type Frontmatter = Awaited<
  ReturnType<(typeof browserCollections)["docs"]["raw"][string]>
>["frontmatter"];

export interface DocPage {
  slug: string;
  /** The file, which keys the compiled page in the collection. */
  path: string;
  title: string;
  description: string;
  order: number;
}

// Only the front matter of every page: enough for the navigation.
const files = import.meta.glob<Frontmatter>("./*.mdx", {
  base: "/src/web/content/docs",
  query: { collection: "docs", only: "frontmatter" },
  import: "frontmatter",
  eager: true,
});

const pages: DocPage[] = Object.entries(files)
  .map(([file, data]) => {
    const path = file.slice("./".length);
    return {
      slug: path.replace(/\.mdx$/, ""),
      path,
      title: data.title,
      description: data.description,
      order: data.order,
    };
  })
  .sort((a, b) => a.order - b.order);

/** Every page, in the order of the navigation. The first is the docs' home. */
export const listDocs = (): DocPage[] => pages;

export const findDoc = (slug: string): DocPage | undefined =>
  pages.find((page) => page.slug === slug);
