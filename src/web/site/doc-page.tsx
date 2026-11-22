import { Link } from "@tanstack/react-router";
import type { MDXProps } from "mdx/types";
import type { FC } from "react";
import { cn } from "@/lib/utils";
import type { DocPage } from "./docs";

/** A page of the docs: the list of pages beside it, the page itself in a readable measure. */
export function DocLayout({
  Mdx,
  page,
  pages,
}: {
  Mdx: FC<MDXProps>;
  page: DocPage;
  pages: DocPage[];
}) {
  const index = pages.findIndex((candidate) => candidate.slug === page.slug);
  const next = pages[index + 1];
  return (
    <div className="mx-auto flex w-full max-w-6xl gap-12 px-6 pt-10 sm:pt-14">
      <nav aria-label="Documentation" className="hidden w-52 shrink-0 md:block">
        <p className="px-2 text-[13px] font-medium">Documentation</p>
        <ul className="mt-2 flex flex-col gap-0.5">
          {pages.map((candidate) => (
            <li key={candidate.slug}>
              <Link
                to={candidate.order === pages[0]?.order ? "/docs" : "/docs/$slug"}
                params={{ slug: candidate.slug }}
                className={cn(
                  "block rounded-md px-2 py-1.5 text-[14px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                  candidate.slug === page.slug && "bg-muted font-medium text-foreground",
                )}
              >
                {candidate.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className="min-w-0 max-w-2xl flex-1">
        <h1 className="font-display text-[34px] leading-[1.12] font-semibold tracking-[-0.03em] text-balance sm:text-[38px]">
          {page.title}
        </h1>
        <p className="mt-3 text-[17px] leading-7 text-pretty text-muted-foreground">
          {page.description}
        </p>
        <div className="prose-site mt-10">
          <Mdx />
        </div>
        {next && (
          <p className="mt-16 border-t pt-6 text-[14px] text-muted-foreground">
            Next:{" "}
            <Link
              to="/docs/$slug"
              params={{ slug: next.slug }}
              className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
            >
              {next.title}
            </Link>
          </p>
        )}
        {/* On a phone the navigation is a list at the end. */}
        <nav aria-label="All pages" className="mt-12 md:hidden">
          <p className="text-[13px] font-medium">All pages</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {pages.map((candidate) => (
              <li key={candidate.slug}>
                <Link
                  to="/docs/$slug"
                  params={{ slug: candidate.slug }}
                  className="text-[14px] text-muted-foreground hover:text-foreground"
                >
                  {candidate.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </article>
    </div>
  );
}
