import { expect, type Page, test } from "@playwright/test";
import { fixtureUrl, follow, shot, signIn } from "./helpers.ts";
import { ADMIN_PASSWORD, PREVIEW } from "./server.ts";

/**
 * The public site: the landing page and the blog, which the server renders.
 * The suite switches it on (PUBLIC_SITE); a self-hosted instance leaves it off.
 */
const POST = "/blog/stale-while-revalidate-is-the-wrong-default";

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

  // The connect step takes the URL from there and connects it. This document
  // already is a project (the journeys before made it), so it opens that one.
  await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+\/new$/, { timeout: 30_000 });
  await expect(page.getByLabel("Variant name")).toBeVisible();
});

test("someone who is signed in gets the app at /, not the landing page", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/(p\/prj_|connect)/);
});

test("the blog lists published posts, and drafts only while developing", async ({
  page,
  request,
}) => {
  const problems = problemsOf(page);
  await page.goto("/blog");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blog");

  // Published posts are listed in every build, and are indexable.
  await follow(
    page,
    page.getByRole("link", { name: "How to merge several OpenAPI documents into one" }),
    "/blog/merge-multiple-openapi-documents",
  );
  await expect(page.getByRole("heading", { name: "What collides" })).toBeVisible();
  const published = await (await request.get("/blog/merge-multiple-openapi-documents")).text();
  expect(published).not.toContain('content="noindex"');
  await page.goto("/blog");

  if (PREVIEW) {
    await expect(page.getByText("Draft, not published")).toHaveCount(0);
    expect((await request.get(POST)).status()).toBe(404);
    return;
  }

  await expect(page.getByText("Draft, not published")).toBeVisible();
  await follow(
    page,
    page.getByRole("link", { name: /stale-while-revalidate is the wrong default/ }),
    POST,
  );
  await expect(page.getByRole("heading", { level: 1 })).toContainText("stale-while-revalidate");
  await expect(page.getByRole("heading", { name: "Who reads an OpenAPI document" })).toBeVisible();
  expect(problems).toEqual([]);
  await shot(page, "site-03-post", { fullPage: true });

  // The post is in the HTML the server sends, and a draft asks not to be indexed.
  const html = await (await request.get(POST)).text();
  expect(html).toContain("Who reads an OpenAPI document");
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
  expect(urls).not.toContain(POST);

  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toMatch(/^Sitemap: http:\/\/[^\s]+\/sitemap\.xml$/m);
  expect(robots).toContain("Disallow: /api/");

  const feed = await (await request.get("/blog/rss.xml")).text();
  expect(feed).toContain("<title>How to merge several OpenAPI documents into one</title>");
  expect(feed).not.toContain(POST);

  // A post is an article with a cover of its own as its social card.
  const html = await (await request.get(published)).text();
  expect(html).toContain('"@type":"BlogPosting"');
  expect(html).toContain("/site/blog/merge-multiple-openapi-documents-og.jpg");
  expect((await request.get("/site/blog/merge-multiple-openapi-documents.jpg")).status()).toBe(200);
});

test("the docs explain checks, and the Source page points to the right page", async ({ page }) => {
  const problems = problemsOf(page);
  const response = await page.goto("/docs/etag");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sending an ETag");
  await expect(page.getByText("If-None-Match").first()).toBeVisible();
  // The pages are listed beside it, with search above them.
  const sidebar = page.locator("#nd-sidebar");
  await expect(sidebar.getByRole("button", { name: /Search/ })).toBeVisible();
  await sidebar.getByRole("link", { name: "A version endpoint" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A version endpoint");
  await shot(page, "site-04-docs", { fullPage: true });
  await sidebar.getByRole("link", { name: "Environments and servers" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Environments and servers");
  expect(problems).toEqual([]);

  // The fixture API sends no ETag, so the Source page says what that costs and links here.
  await signIn(page);
  const projects = (await (await page.request.get("/api/projects")).json()) as Array<{
    id: string;
    sources: Array<{ versionUrl: string | null }>;
  }>;
  // A project of one document, which is shown opened, without a version endpoint.
  const project = projects.find(
    (candidate) => candidate.sources.length === 1 && candidate.sources[0]?.versionUrl === null,
  );
  await page.goto(`/p/${project?.id}/settings`);
  await page.getByRole("table").getByRole("button").first().click();
  await expect(page.getByText(/Each check downloads the whole document/)).toBeVisible();
  await expect(page.getByRole("link", { name: "How to send one" })).toHaveAttribute(
    "href",
    "/docs/etag",
  );
  await expect(page.getByRole("link", { name: "What it can return" })).toHaveAttribute(
    "href",
    "/docs/version-endpoint",
  );
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
