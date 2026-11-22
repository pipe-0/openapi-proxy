import { notFound } from "@tanstack/react-router";
import browserCollections from "collections/browser";
import type { MDXProps } from "mdx/types";
import type { FC } from "react";
import { originOf, siteHead } from "./site";

type Frontmatter = Awaited<
  ReturnType<(typeof browserCollections)["legal"]["raw"][string]>
>["frontmatter"];

export interface LegalPage {
  slug: "about" | "terms" | "privacy";
  path: string;
  title: string;
  description: string;
  updated: string;
}

const files = import.meta.glob<Frontmatter>("./*.mdx", {
  base: "/src/web/content/legal",
  query: { collection: "legal", only: "frontmatter" },
  import: "frontmatter",
  eager: true,
});

function findPage(slug: LegalPage["slug"]): LegalPage | undefined {
  const data = files[`./${slug}.mdx`];
  if (!data) return undefined;
  return {
    slug,
    path: `${slug}.mdx`,
    title: data.title,
    description: data.description,
    updated: new Date(data.updated).toISOString().slice(0, 10),
  };
}

const content = browserCollections.legal.createClientLoader({
  id: "legal",
  component({ default: Mdx }, props: { page: LegalPage }) {
    return <Article Mdx={Mdx} page={props.page} />;
  },
});

/** A route's loader: the page, compiled and ready for the server to render. */
export async function loadLegal(slug: LegalPage["slug"]): Promise<{ page: LegalPage }> {
  const page = findPage(slug);
  if (!page) throw notFound();
  await content.preload(page.path);
  return { page };
}

/** A route's head: title, description and the social card. */
export function legalHead({
  loaderData,
  matches,
}: {
  loaderData?: { page: LegalPage } | undefined;
  matches: ReadonlyArray<{ routeId: string; loaderData?: unknown }>;
}) {
  if (!loaderData) return {};
  const { page } = loaderData;
  const origin = originOf(matches);
  const title = `${page.title} · openapi-proxy`;
  return origin
    ? siteHead({ title, description: page.description, url: `${origin}/${page.slug}` })
    : { meta: [{ title }] };
}

export function LegalView({ page }: { page: LegalPage }) {
  return content.useContent(page.path, { page });
}

function Article({ Mdx, page }: { Mdx: FC<MDXProps>; page: LegalPage }) {
  return (
    <article className="mx-auto max-w-2xl px-6 pt-14 sm:pt-20">
      <h1 className="font-display text-[34px] leading-[1.12] font-semibold tracking-[-0.03em] sm:text-[38px]">
        {page.title}
      </h1>
      {page.slug !== "about" && (
        <p className="mt-3 text-[14px] text-muted-foreground">
          Last updated{" "}
          {new Date(`${page.updated}T00:00:00Z`).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          })}
        </p>
      )}
      <div className="prose-site mt-10">
        <Mdx />
      </div>
    </article>
  );
}
