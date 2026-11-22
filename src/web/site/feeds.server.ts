import { listPosts } from "./blog";
import { docsPaths, source } from "./docs.server";
import { SITE_DESCRIPTION, SITE_NAME } from "./site";

/**
 * The files search engines and feed readers ask for: sitemap.xml, robots.txt
 * and the blog's RSS feed. Each is built from the same lists the pages use,
 * on the origin it was requested on, so a post is in all three the moment it
 * is published. They exist only where the public site is switched on.
 */

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const xml = (body: string, type: string) =>
  new Response(body, {
    headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "public, max-age=3600" },
  });

export function sitemapXml(origin: string): Response {
  const posts = listPosts().filter((post) => !post.draft);
  const entries: Array<{ path: string; lastmod?: string; priority: number }> = [
    { path: "/", priority: 1 },
    { path: "/pricing", priority: 0.8 },
    { path: "/blog", lastmod: posts[0]?.date, priority: 0.8 },
    ...posts.map((post) => ({ path: post.url, lastmod: post.date, priority: 0.7 })),
    ...docsPaths().map((path) => ({ path, priority: path === "/docs" ? 0.7 : 0.6 })),
    { path: "/about", priority: 0.3 },
    { path: "/terms", priority: 0.2 },
    { path: "/privacy", priority: 0.2 },
  ];
  const urls = entries.map(
    (entry) =>
      `  <url>\n    <loc>${escapeXml(new URL(entry.path, origin).href)}</loc>\n${
        entry.lastmod ? `    <lastmod>${entry.lastmod}</lastmod>\n` : ""
      }    <priority>${entry.priority}</priority>\n  </url>`,
  );
  return xml(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
    "application/xml",
  );
}

export function robotsTxt(origin: string): Response {
  // The app answers with `X-Robots-Tag: noindex` anyway; listing it here
  // keeps crawlers from spending their visits on it.
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /v/",
    "Disallow: /mcp",
    "Disallow: /app",
    "Disallow: /p/",
    "Disallow: /connect",
    "Disallow: /login",
    "Disallow: /invite/",
    "Disallow: /workspace",
    "",
    `Sitemap: ${new URL("/sitemap.xml", origin).href}`,
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

export function rssXml(origin: string): Response {
  const posts = listPosts().filter((post) => !post.draft);
  const items = posts.map((post) => {
    const url = escapeXml(new URL(post.url, origin).href);
    return `    <item>\n      <title>${escapeXml(post.title)}</title>\n      <link>${url}</link>\n      <guid isPermaLink="true">${url}</guid>\n      <description>${escapeXml(post.description)}</description>\n      <pubDate>${new Date(`${post.date}T00:00:00Z`).toUTCString()}</pubDate>\n    </item>`;
  });
  return xml(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${SITE_NAME} blog</title>\n    <link>${escapeXml(new URL("/blog", origin).href)}</link>\n    <description>${escapeXml(SITE_DESCRIPTION)}</description>\n    <language>en</language>\n${items.join("\n")}\n  </channel>\n</rss>\n`,
    "application/rss+xml",
  );
}

/**
 * llms.txt: what this is and where its pages are, as a language model wants
 * it (https://llmstxt.org). Posts are linked as their Markdown, which is the
 * same text without the page around it.
 */
export function llmsTxt(origin: string): Response {
  const at = (path: string) => new URL(path, origin).href;
  const posts = listPosts().filter((post) => !post.draft);
  const lines = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    "openapi-proxy fetches the OpenAPI document a backend generates, keeps the operations each audience should see (a variant), and serves each variant at a URL of its own as JSON or YAML, in OpenAPI 3.0 or 3.1. A variant is public, or private and read with an API key. Several documents can be merged into one. It is open source and runs on Cloudflare Workers; a hosted version is at openapi-proxy.app.",
    "",
    "## Product",
    "",
    `- [${SITE_NAME}](${at("/")}): what it does and how to start`,
    `- [Pricing](${at("/pricing")}): the free plan and Pro`,
    "",
    "## Documentation",
    "",
    ...source
      .getPages()
      .map((page) => `- [${page.data.title}](${at(page.url)}): ${page.data.description}`),
    "",
    "## Blog",
    "",
    ...posts.map((post) => `- [${post.title}](${at(`${post.url}.md`)}): ${post.description}`),
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
