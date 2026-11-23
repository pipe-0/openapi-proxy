import { source } from "./docs.server";

/** The pages of the docs in the order of the navigation: guides first, then reference. */
export function docsInOrder() {
  const pages = source.getPages();
  const order: string[] = [];
  const walk = (nodes: ReturnType<typeof source.getPageTree>["children"]) => {
    for (const node of nodes) {
      if (node.type === "page") order.push(node.url);
      else if (node.type === "folder") walk(node.children);
    }
  };
  walk(source.getPageTree().children);
  return [...pages].sort((a, b) => order.indexOf(a.url) - order.indexOf(b.url));
}

/** Where a page's Markdown is: its address with `.md`, and `/docs/index.md` for the first page. */
export const markdownPath = (url: string): string =>
  url === "/docs" ? "/docs/index.md" : `${url}.md`;

/**
 * Links as an agent needs them when all it has is this text: whole addresses,
 * and for other pages of the docs, their Markdown.
 */
function withWholeLinks(text: string, origin: string): string {
  return text.replace(/\]\((\/[^)\s]*)\)/g, (_, path: string) => {
    const [, page = "", rest = ""] = /^(\/docs(?:\/[a-z0-9-]+)?)(#.*)?$/.exec(path) ?? [];
    const target = page ? `${markdownPath(page)}${rest}` : path;
    return `](${new URL(target, origin).href})`;
  });
}

type DocsPage = ReturnType<typeof source.getPages>[number];

// The text of every page as it was written, each loaded when it is asked for.
// Pages are Markdown with a front matter block, so the file is the Markdown.
const sources = import.meta.glob<string>("./*.mdx", {
  base: "/src/web/content/docs",
  query: "?raw",
  import: "default",
});
// And the example files that pages show with `<include>`: the same files CI checks.
const examples = import.meta.glob<string>(
  ["./*/*.{yaml,yml,json}", "./*/.github/workflows/*.yml"],
  {
    base: "/examples",
    query: "?raw",
    import: "default",
    // A workflow lives in a folder whose name starts with a dot, which is skipped otherwise.
    exhaustive: true,
  },
);

/** A page's text with the files it includes written out, each under its name. */
async function withIncludes(text: string): Promise<string> {
  const tags = [...text.matchAll(/<include([^>]*)>([^<]+)<\/include>/g)];
  let out = text;
  for (const [tag, attributes = "", path = ""] of tags) {
    const file = path.trim().replace(/^(\.\.\/)+examples\//, "./");
    const content = await examples[file]?.();
    const lang = /lang="([^"]+)"/.exec(attributes)?.[1] ?? "";
    const title = /title="([^"]+)"/.exec(attributes)?.[1];
    const block =
      content === undefined
        ? ""
        : `${title ? `\`${title}\`:\n\n` : ""}\`\`\`${lang}\n${content.trimEnd()}\n\`\`\``;
    // A function, so that a `$&` in a file is text and not a pattern.
    out = out.replace(tag, () => block);
  }
  return out;
}

/** One page as Markdown: what it is called, what it is about, where it lives, and its text. */
export async function pageMarkdown(page: DocsPage, origin: string): Promise<string> {
  const raw = (await sources[`./${page.path}`]?.()) ?? "";
  const text = await withIncludes(raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim());
  return [
    `# ${page.data.title}`,
    "",
    `> ${page.data.description}`,
    "",
    `Source: ${new URL(page.url, origin).href}`,
    "",
    withWholeLinks(text, origin),
    "",
  ].join("\n");
}

const markdown = (body: string) =>
  new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });

/**
 * A page of the docs as plain Markdown, at /docs/<slug>.md. An agent reads
 * this more easily than the page, and it is the whole page: the example
 * files a page shows are written out in it.
 */
export async function docsMarkdown(slug: string, origin: string): Promise<Response> {
  const page = source.getPage(slug === "index" ? [] : [slug]);
  if (!page) return new Response("Not found.\n", { status: 404 });
  return markdown(await pageMarkdown(page, origin));
}

/** Every page of the docs in one file, in the order of the navigation: /llms-full.txt. */
export async function docsFullText(origin: string): Promise<Response> {
  const pages = await Promise.all(docsInOrder().map((page) => pageMarkdown(page, origin)));
  return new Response(pages.join("\n---\n\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
