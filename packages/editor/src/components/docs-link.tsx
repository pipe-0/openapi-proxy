import { createContext, useContext } from "react";

/**
 * Where the docs are. In the app they are on the same site, so this is
 * empty; a page shown somewhere else names the site.
 */
export const DocsSite = createContext("");

/** A link into the docs, opened beside the form so nothing typed here is lost. */
export function DocsLink({ slug, children }: { slug: string; children: React.ReactNode }) {
  const site = useContext(DocsSite);
  return (
    <a
      href={`${site}/docs/${slug}`}
      target="_blank"
      rel="noreferrer"
      className="font-medium whitespace-nowrap text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
    >
      {children}
    </a>
  );
}
