/** A link into the docs, opened beside the form so nothing typed here is lost. */
export function DocsLink({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <a
      href={`/docs/${slug}`}
      target="_blank"
      rel="noreferrer"
      className="font-medium whitespace-nowrap text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
    >
      {children}
    </a>
  );
}
