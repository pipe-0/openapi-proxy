import { findPost, formatDay } from "./blog";

// The text of every post as it was written, each loaded when it is asked for.
// Posts are Markdown with a front matter block, so the file is the Markdown.
const sources = import.meta.glob<string>("./*.mdx", {
  base: "/src/web/content/blog",
  query: "?raw",
  import: "default",
});

/**
 * A post as plain Markdown, at /blog/<slug>.md. An answer engine or an agent
 * reads this more easily than the page, and the header carries what the page
 * shows around the text (dates, where it lives), so a quote keeps its source.
 */
export async function postMarkdown(slug: string, origin: string): Promise<Response> {
  const post = findPost(slug);
  const load = post && sources[`./${post.path}`];
  if (!post || post.draft || !load) return new Response("Not found.\n", { status: 404 });

  const text = (await load()).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  const lines = [
    `# ${post.title}`,
    "",
    [
      `Published ${formatDay(post.date)}`,
      post.updated !== post.date && `Updated ${formatDay(post.updated)}`,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
    `Source: ${new URL(post.url, origin).href}`,
    "",
    `> ${post.description}`,
  ];
  if (post.tldr) lines.push("", `**TL;DR:** ${post.tldr}`);
  lines.push("", text);
  if (post.faq.length > 0) {
    lines.push("", "## Frequently asked questions");
    for (const { q, a } of post.faq) lines.push("", `### ${q}`, "", a);
  }
  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
