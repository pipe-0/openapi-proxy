import { pageSchema } from "fumadocs-core/source/schema";
import { applyMdxPreset, defineCollections, defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

/** Word count of the raw MDX, at a reading pace of about 220 words a minute. */
function readingMinutes(source: string): number {
  const words = source
    .replace(/^---[\s\S]*?---/, "")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

/**
 * The blog: one MDX file per post in src/web/content/blog, named after its
 * slug. `fumadocs-mdx` compiles them at build time into the `collections/*`
 * modules, so the Worker never reads a file.
 */
export const blog = defineCollections({
  type: "doc",
  dir: "src/web/content/blog",
  schema: ({ source }) =>
    pageSchema.extend({
      description: z.string(),
      date: z.iso.date().or(z.date()),
      /** Filled in at build time; the Worker has no files to read. */
      minutes: z.number().default(readingMinutes(source)),
      /**
       * The cover, a path under public/ (e.g. /blog/merge.jpg). Shown above the
       * post, on the cards of the index, and as the post's social image.
       */
      cover: z.string().optional(),
      /** Shown first and largest on the index. One post at a time. */
      featured: z.boolean().optional(),
      /**
       * Not published: shown while developing, 404 and unlisted in a production
       * build. Remove the flag to publish.
       */
      draft: z.boolean().optional(),
    }),
  // Compiled posts load on demand, not all with the first request.
  async: true,
  mdxOptions: applyMdxPreset({
    rehypeCodeOptions: { themes: { light: "github-light", dark: "github-dark" } },
  }),
});

/**
 * The documentation: how to run, connect and tune the proxy. One MDX file per
 * page in src/web/content/docs, named after its slug; `meta.json` there sets
 * the order and the groups of the navigation. Rendered with Fumadocs UI.
 */
export const docs = defineDocs({
  dir: "src/web/content/docs",
  docs: {
    schema: pageSchema.extend({ description: z.string() }),
    // Compiled pages load on demand, so a request does not evaluate every page.
    async: true,
    mdxOptions: applyMdxPreset({
      rehypeCodeOptions: { themes: { light: "github-light", dark: "github-dark" } },
    }),
  },
});

/**
 * About, terms and privacy: pages of the hosted service at openapi-proxy.app,
 * served only when PUBLIC_SITE is on. A self-hosted instance is run by
 * whoever hosts it, and these pages do not speak for them.
 */
export const legal = defineCollections({
  type: "doc",
  dir: "src/web/content/legal",
  schema: pageSchema.extend({
    description: z.string(),
    /** ISO date of the last change that matters to a reader. */
    updated: z.iso.date().or(z.date()),
  }),
  async: true,
  mdxOptions: applyMdxPreset(),
});

export default defineConfig();
