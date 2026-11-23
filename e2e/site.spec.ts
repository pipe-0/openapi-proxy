import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { fixtureUrl, follow, root, shot, signIn } from "./helpers.ts";
import { ADMIN_PASSWORD, PREVIEW } from "./server.ts";

/**
 * The public site: the landing page and the blog, which the server renders.
 * The suite switches it on (PUBLIC_SITE); a self-hosted instance leaves it off.
 */

/**
 * A post that is being written (`draft: true`), if there is one at the
 * moment: where it is, and what it is called. What holds for drafts is
 * checked on it. Without one, the journeys check that nothing claims to be a draft.
 */
const DRAFT = (() => {
  const posts = join(root, "src/web/content/blog");
  for (const file of readdirSync(posts).filter((name) => name.endsWith(".mdx"))) {
    const text = readFileSync(join(posts, file), "utf8");
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    if (!/^draft: true$/m.test(front)) continue;
    const title = /^title: "?(.*?)"?$/m.exec(front)?.[1] ?? "";
    return { path: `/blog/${file.replace(/\.mdx$/, "")}`, title };
  }
  return undefined;
})();

/** Collect everything the page complains about: script errors and blocked resources. */
function problemsOf(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  return problems;
}

test("the landing page is rendered by the server and runs clean", async ({ page, request }) => {
  // The words are in the HTML itself, before any script runs.
  const response = await request.get("/");
  const html = await response.text();
  expect(html).toContain("that lives on the edge.");
  // One title, a canonical URL and a social card; nothing that keeps it out of search.
  expect(html.match(/<title>/g)).toHaveLength(1);
  expect(html).toContain('rel="canonical"');
  expect(html).toContain('property="og:image"');
  expect(html).not.toContain('name="robots"');
  expect(response.headers()["x-robots-tag"]).toBeUndefined();
  // The app, in contrast, is never to be indexed.
  expect((await request.get("/login")).headers()["x-robots-tag"]).toBe("noindex");

  // The production build sends a policy that allows our files and the inline
  // scripts of this one response, and nothing else inline.
  if (PREVIEW) {
    const policy = response.headers()["content-security-policy"] ?? "";
    expect(policy).toMatch(/script-src 'self' 'nonce-[0-9a-f]{32}';/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(html).toContain(`nonce="${/'nonce-([0-9a-f]{32})'/.exec(policy)?.[1]}"`);
  }

  const problems = problemsOf(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "The OpenAPI toolchain that lives on the edge.",
  );
  // The problem comes before the features: many consumers of one document, and an endpoint not yet announced.
  await expect(
    page.getByRole("heading", { name: "One OpenAPI document. Many consumers." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ship the endpoint now. Publish it when it is ready." }),
  ).toBeVisible();
  // Each use case points to the post that explains it, and the post exists.
  await expect(
    page.getByRole("link", { name: "Read the post: Several services, one document" }),
  ).toHaveAttribute("href", "/blog/merge-multiple-openapi-documents");
  await expect(page).toHaveTitle(/openapi-proxy/);
  // Plan limits come from the code that enforces them.
  await expect(page.getByText("15 variants")).toBeVisible();
  // Pro is bought from the workspace, not from the site.
  await expect(page.getByRole("link", { name: "Compare plans" })).toHaveAttribute(
    "href",
    "/pricing",
  );
  // Let lazy images and hydration settle before judging the console.
  await page.getByRole("img", { name: /variant editor/ }).scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);

  await page.evaluate("window.scrollTo(0, 0)");
  await shot(page, "site-01-landing-desktop", { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "site-02-landing-phone", { fullPage: true });
});

test("the hero carries a pasted URL through sign-in and connects it", async ({ page }) => {
  const url = fixtureUrl("/openapi.json");
  await page.goto("/");
  await page.getByLabel("URL of your OpenAPI document").first().fill(url);
  await page.getByRole("button", { name: "Continue" }).first().click();

  await expect(page).toHaveURL(/\/login\?from=/);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByLabel("Password").press("Enter");

  // The connect step has the URL from there. What is left to say is what the
  // project is called in its URLs.
  await expect(page.getByLabel("OpenAPI document URL")).toHaveValue(url);
  await page.getByLabel("Project URL slug").fill("from-the-hero");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/\/p\/from-the-hero\/new$/, { timeout: 30_000 });
  await expect(page.getByLabel("Variant name")).toBeVisible();
});

test("someone who is signed in gets the app at /, not the landing page", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/(p\/|connect)/);
});

test("the blog lists published posts, and drafts only while developing", async ({
  page,
  request,
}) => {
  const problems = problemsOf(page);
  await page.goto("/blog");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blog");
  await shot(page, "site-08-blog-index", { fullPage: true });

  // Published posts are listed in every build, and are indexable.
  await follow(
    page,
    page.getByRole("link", { name: "How to merge several OpenAPI documents into one" }),
    "/blog/merge-multiple-openapi-documents",
  );
  await expect(page.getByRole("heading", { name: "What collides" })).toBeVisible();
  const published = await (await request.get("/blog/merge-multiple-openapi-documents")).text();
  expect(published).not.toContain('content="noindex"');

  // What a reader in a hurry, and an answer engine, take from a post: the
  // post in a few sentences above the text, and the questions it answers.
  await expect(page.getByRole("complementary", { name: "TL;DR" })).toContainText(
    "Merging independent OpenAPI documents goes wrong in four places",
  );
  await expect(page.getByRole("heading", { name: "Frequently asked questions" })).toBeVisible();
  const question = page.getByText("How do I combine multiple OpenAPI files into one?");
  const answer = page.getByText(/bundle it with redocly bundle or swagger-cli bundle/);
  await expect(answer).toBeHidden();
  await question.click();
  await expect(answer).toBeVisible();
  await shot(page, "site-07-post-with-tldr-and-faq", { fullPage: true });
  // The same, marked up for machines: the article, where it sits, its questions.
  const marked = (await page.locator('script[type="application/ld+json"]').allTextContents()).map(
    (text) => JSON.parse(text) as { "@type": string; abstract?: string; mainEntity?: unknown[] },
  );
  expect(marked.map((item) => item["@type"]).sort()).toEqual([
    "BlogPosting",
    "BreadcrumbList",
    "FAQPage",
  ]);
  expect(marked.find((item) => item["@type"] === "BlogPosting")?.abstract).toContain("four places");
  expect(marked.find((item) => item["@type"] === "FAQPage")?.mainEntity).toHaveLength(3);
  // And as plain Markdown, which the page points to.
  await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute(
    "href",
    /\/blog\/merge-multiple-openapi-documents\.md$/,
  );
  const markdown = await request.get("/blog/merge-multiple-openapi-documents.md");
  expect(markdown.status()).toBe(200);
  expect(markdown.headers()["content-type"]).toContain("text/markdown");
  const text = await markdown.text();
  expect(text).toMatch(/^# How to merge several OpenAPI documents into one\n/);
  expect(text).toContain("**TL;DR:** Merging independent OpenAPI documents");
  expect(text).toContain("## What collides");
  expect(text).toContain(
    "### What is the difference between bundling and merging OpenAPI documents?",
  );
  expect(text).not.toMatch(/^---$/m);
  // A draft has no Markdown to hand out, in any build.
  if (DRAFT) expect((await request.get(`${DRAFT.path}.md`)).status()).toBe(404);
  // llms.txt lists the docs and the posts, each as its Markdown.
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  const index = await llms.text();
  expect(index).toMatch(/^# openapi-proxy\n/);
  expect(index).toContain("## Documentation");
  expect(index).toMatch(/\/docs\/selecting\.md\): /);
  expect(index).toMatch(/\/blog\/filter-openapi-by-tag\.md\): /);
  if (DRAFT) expect(index).not.toContain(DRAFT.path);
  await page.goto("/blog");

  // A production build knows no drafts. Neither does a development server while none is being written.
  if (PREVIEW || !DRAFT) {
    await expect(page.getByText("Draft, not published")).toHaveCount(0);
    if (DRAFT) expect((await request.get(DRAFT.path)).status()).toBe(404);
    expect(problems).toEqual([]);
    return;
  }

  await expect(page.getByText("Draft, not published").first()).toBeVisible();
  await follow(page, page.getByRole("link", { name: DRAFT.title }), DRAFT.path);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(DRAFT.title);
  expect(problems).toEqual([]);
  await shot(page, "site-03-post", { fullPage: true });

  // The post is in the HTML the server sends, and a draft asks not to be indexed.
  const html = await (await request.get(DRAFT.path)).text();
  expect(html).toContain(DRAFT.title);
  expect(html).toContain('content="noindex"');
});

test("pricing compares the plans with the limits the server enforces", async ({ page }) => {
  const problems = problemsOf(page);
  expect((await page.goto("/pricing"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pricing");
  await expect(page.getByText("$69")).toBeVisible();
  // The numbers come from shared/plans.ts, like the landing page's.
  const projects = page.getByRole("row", { name: /^Projects/ });
  await expect(projects.getByRole("cell")).toHaveText(["3", "100", "100"]);
  // Hosted and self-hosted are told apart.
  await expect(page.getByRole("heading", { name: "Hosted at openapi-proxy.app" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Self-hosted" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get Pro" })).toHaveAttribute("href", "/workspace");
  await shot(page, "site-06-pricing", { fullPage: true });
  expect(problems).toEqual([]);

  // Someone signed out who wants Pro signs in and lands where upgrading is explained.
  await page.context().clearCookies();
  await page.getByRole("link", { name: "Get Pro" }).click();
  await expect(page).toHaveURL(/\/login\?from=/);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByLabel("Password").press("Enter");
  await expect(page).toHaveURL(/\/workspace$/);
});

test("the site tells search engines and feed readers what there is", async ({ request }) => {
  const published = "/blog/merge-multiple-openapi-documents";

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  const urls = await sitemap.text();
  expect(urls).toContain(`${published}</loc>`);
  expect(urls).toContain("/pricing</loc>");
  expect(urls).toContain("/docs/merging</loc>");
  if (DRAFT) expect(urls).not.toContain(DRAFT.path);

  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toMatch(/^Sitemap: http:\/\/[^\s]+\/sitemap\.xml$/m);
  expect(robots).toContain("Disallow: /api/");

  const feed = await (await request.get("/blog/rss.xml")).text();
  expect(feed).toContain("<title>How to merge several OpenAPI documents into one</title>");
  if (DRAFT) expect(feed).not.toContain(DRAFT.path);

  // A post is an article with a cover of its own as its social card.
  const html = await (await request.get(published)).text();
  expect(html).toContain('"@type":"BlogPosting"');
  expect(html).toContain("/site/blog/merge-multiple-openapi-documents-og.jpg");
  expect((await request.get("/site/blog/merge-multiple-openapi-documents.jpg")).status()).toBe(200);
});

test("the docs are ordered by what someone wants to do, and the app points into them", async ({
  page,
}) => {
  const problems = problemsOf(page);
  const response = await page.goto("/docs");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Start here");
  // The two ways, in the words the app and the command line tool use for them.
  await expect(page.getByText(/The service reads it, keeps reading it/)).toBeVisible();
  await expect(page.getByText(/written in a file next to your code/)).toBeVisible();

  // The pages are listed beside it, guides first, with search above them.
  const sidebar = page.locator("#nd-sidebar");
  await expect(sidebar.getByRole("button", { name: /Search/ })).toBeVisible();
  const listed = (await sidebar.getByRole("link").allTextContents()).map((text) => text.trim());
  const pages = [
    "Start here",
    "From a URL",
    "Several documents and audiences",
    "In your repository",
    "Configuration file",
    "CLI",
    "URLs, formats and versions",
    "Selecting operations",
    "Merging rules",
    "Following a URL",
    "Private variants and keys",
    "Self-hosting",
  ];
  expect(listed.filter((text) => pages.includes(text))).toEqual(pages);
  await sidebar.getByRole("link", { name: "In your repository" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("In your repository");
  // The workflow on the page is the file in examples/, which CI checks.
  await expect(page.getByText("npx @pipe0/openapi-proxy deploy").first()).toBeVisible();
  await expect(page.getByText("name: OpenAPI documents")).toBeVisible();
  await shot(page, "site-04-docs", { fullPage: true });
  await sidebar.getByRole("link", { name: "Following a URL" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Following a URL");
  await expect(page.getByRole("heading", { name: "Sending an ETag" })).toBeVisible();
  await expect(page.getByText("If-None-Match").first()).toBeVisible();
  expect(problems).toEqual([]);

  // The fixture API sends no ETag, so the project says what that costs and links to how to send one.
  await signIn(page);
  const projects = (await (await page.request.get("/api/projects")).json()) as Array<{
    definition: { project: string };
    state: { check: object | null; sources: Array<{ validator: string | null }> };
  }>;
  // A project of one followed document that sends no validator.
  const project = projects.find(
    ({ state }) =>
      state.check !== null && state.sources.length === 1 && state.sources[0]?.validator === null,
  );
  await page.goto(`/p/${project?.definition.project}/settings`);
  await page.getByRole("table").getByRole("button").first().click();
  await expect(page.getByText(/Each check downloads the whole document/)).toBeVisible();
  await expect(page.getByRole("link", { name: "How to send one" })).toHaveAttribute(
    "href",
    "/docs/following-a-url#sending-an-etag",
  );
});

test("every page of the docs is also Markdown, for an agent", async ({ request }) => {
  const llms = await (await request.get("/llms.txt")).text();
  // The guide an agent is sent here for comes first, before the rest of the docs.
  expect(llms.indexOf("## Setting up a repository")).toBeGreaterThan(0);
  expect(llms.indexOf("## Setting up a repository")).toBeLessThan(llms.indexOf("## Documentation"));
  expect(llms).toMatch(
    /Setting up a repository\n\n- \[In your repository\]\(\S+\/docs\/in-your-repository\.md\)/,
  );
  expect(llms).toContain("/schema/definition.v1.json");

  // Every page in the sitemap has a twin, and llms.txt links every twin.
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const pages = [...sitemap.matchAll(/<loc>[^<]*?(\/docs(?:\/[a-z0-9-]+)?)<\/loc>/g)].map(
    (match) => match[1] as string,
  );
  expect(pages.length).toBeGreaterThanOrEqual(12);
  for (const path of pages) {
    const twin = path === "/docs" ? "/docs/index.md" : `${path}.md`;
    const response = await request.get(twin);
    expect(response.status(), twin).toBe(200);
    expect(response.headers()["content-type"], twin).toContain("text/markdown");
    const text = await response.text();
    expect(text, twin).toMatch(/^# .+\n\n> .+\n\nSource: http/);
    // It is Markdown all the way through: no front matter, no tags left from the page.
    expect(text, twin).not.toMatch(/^---$/m);
    expect(text, twin).not.toContain("<include");
    expect(llms, twin).toContain(`${twin})`);
  }

  // A page that shows an example file has the file in it, written out.
  const guide = await (await request.get("/docs/in-your-repository.md")).text();
  expect(guide).toContain("name: OpenAPI documents");
  expect(guide).toContain("secrets.OPENAPI_PROXY_API_KEY");
  // Links lead to Markdown too, by whole addresses.
  expect(guide).toMatch(/\]\(http:\/\/[^)]+\/docs\/configuration\.md\)/);
  expect(guide).not.toMatch(/\]\(\/docs\//);

  // All of it in one file.
  const full = await request.get("/llms-full.txt");
  expect(full.status()).toBe(200);
  const everything = await full.text();
  for (const title of ["# Start here", "# In your repository", "# Configuration file", "# CLI"]) {
    expect(everything).toContain(`${title}\n`);
  }
  expect(everything.indexOf("# In your repository")).toBeLessThan(
    everything.indexOf("# Configuration file"),
  );
  expect((await request.get("/docs/nope.md")).status()).toBe(404);
});

test("about, terms and privacy belong to the public site, and sign-in points to them", async ({
  page,
}) => {
  for (const [path, heading] of [
    ["/about", "About"],
    ["/terms", "Terms of service"],
    ["/privacy", "Privacy policy"],
  ] as const) {
    expect((await page.goto(path))?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }
  await expect(page.getByText("Pipe0 GmbH (Schweiz)").first()).toBeVisible();
  await shot(page, "site-05-privacy", { fullPage: true });

  await page.context().clearCookies();
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "terms" })).toHaveAttribute("href", "/terms");
  await expect(page.getByRole("link", { name: "privacy policy" })).toHaveAttribute(
    "href",
    "/privacy",
  );
});
