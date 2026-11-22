import { expect, type Page, test } from "@playwright/test";
import { fixtureUrl, shot, signIn } from "./helpers.ts";
import { ADMIN_PASSWORD, FIXTURE_TOKEN } from "./server.ts";

/**
 * The product promise, end to end: sign in, point at a document, pick what to
 * publish, get a URL, and that URL serves exactly the selection. Runs against
 * the pipe0 reference spec served from a local fixture server.
 */
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 } });

const laterAre = (page: Page) =>
  page.getByRole("radiogroup", { name: "Operations the source adds later are" });

test("from a URL to a served variant", async ({ page, request }) => {
  // ---- Sign in ----
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
  await shot(page, "01-sign-in");
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByLabel("Password").press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Incorrect password.");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByLabel("Password").press("Enter");

  // ---- First run: one field. Pasting a URL connects it and opens the editor. ----
  await expect(page.getByRole("heading", { level: 1 })).toContainText("One OpenAPI document in");
  await shot(page, "02-connect");
  await page.getByLabel("OpenAPI document URL").fill(fixtureUrl("/openapi.json"));
  await page.getByLabel("OpenAPI document URL").press("Enter");

  // ---- Editor: a new variant of the freshly created project ----
  await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+\/new$/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Pipe0 API");
  await expect(page.getByTestId("served-operations")).toHaveText("0");

  // A whole tag is one click and becomes a rule; single operations are pinned.
  await page.getByLabel("Search: serve all operations").click();
  await expect(page.getByText("Rule", { exact: true })).toBeVisible();
  await page.getByLabel("GET /v1/{organizationId}/constants", { exact: true }).click();
  await expect(page.getByTestId("served-operations")).toHaveText("7");
  // The document on the right is the real result, live.
  await expect(page.getByTestId("result-document")).toContainText('"openapi": "3.1.0"');

  // Naming it derives the slug and shows the URL being created.
  await page.getByLabel("Variant name").fill("Public docs");
  await expect(page.getByLabel("URL slug")).toHaveValue("public-docs");
  await expect(page.getByText("/v/pipe0/")).toBeVisible();
  await page.getByLabel("Pipes: serve all operations").scrollIntoViewIfNeeded();
  await shot(page, "03-editor-new");

  await page.getByRole("button", { name: /Create variant/ }).click();

  // ---- The same screen, now live: the URL is first, ready to copy ----
  await expect(page).toHaveURL(/\/v\/var_/);
  await expect(page.getByTestId("variant-url")).toHaveText(/\/v\/pipe0\/public-docs\.json$/);
  await expect(page.getByRole("button", { name: "Copy URL" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Public docs" })).toBeVisible();

  // ---- The URL serves exactly the selection ----
  const served = await request.get("/v/pipe0/public-docs.json");
  expect(served.status()).toBe(200);
  const etag = served.headers().etag;
  expect(etag).toBeTruthy();
  const body = await served.text();
  // The source is minified, so the output is too.
  expect(body).not.toContain("\n");
  const doc = JSON.parse(body) as {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };
  expect(Object.values(doc.paths).flatMap((item) => Object.keys(item))).toHaveLength(7);
  expect(doc.components.schemas.PipePayload).toBeUndefined();

  const yaml = await request.get("/v/pipe0/public-docs.yaml");
  expect(yaml.headers()["content-type"]).toContain("application/yaml");
  expect(await yaml.text()).toMatch(/^openapi: 3\.1\.0/);
  const notModified = await request.get("/v/pipe0/public-docs.json", {
    headers: { "if-none-match": etag as string },
  });
  expect(notModified.status()).toBe(304);

  // ---- Changes are staged, then published ----
  await page.getByLabel("POST /v1/pipes/run", { exact: true }).click();
  await expect(page.getByText("Unpublished changes")).toBeVisible();
  await expect(page.getByTestId("served-operations")).toHaveText("8");
  // This picture goes into the README and onto the landing page: show the
  // address a reader would have, not the port this test happens to run on.
  await page.evaluate(
    `document.querySelector('[data-testid="variant-url"] span').textContent = "https://proxy.example.com"`,
  );
  await shot(page, "04-editor");
  // Nothing is served differently until it is published.
  expect((await request.get("/v/pipe0/public-docs.json")).headers().etag).toBe(etag);
  await page.getByRole("button", { name: /Publish changes/ }).click();
  await expect(page.getByText("Unpublished changes")).toBeHidden();
  expect((await request.get("/v/pipe0/public-docs.json")).headers().etag).not.toBe(etag);

  // ---- Overview lists it ----
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pipe0 API");
  await expect(page.getByRole("cell", { name: "/v/pipe0/public-docs" })).toBeVisible();
  await expect(page.getByText("8 of 30")).toBeVisible();
  await shot(page, "05-overview");
});

test("source settings: version endpoint and URL prefix", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Sources" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sources");
  await shot(page, "06-source");

  // An endpoint that reports nothing is refused, with the reason.
  await page.getByLabel("Version endpoint").fill(fixtureUrl("/nothing-here"));
  await page.getByRole("button", { name: "Save document settings" }).click();
  await expect(page.getByRole("alert")).toContainText("No version could be read");

  await page.getByLabel("Version endpoint").fill(fixtureUrl("/version"));
  await page.getByRole("button", { name: "Save document settings" }).click();
  await expect(page.getByText("x-api-version: 1")).toBeVisible();

  // Renaming the prefix moves every variant URL.
  await page.getByLabel("Project URL slug").fill("pipe");
  await expect(page.getByText("The old URLs will return 404")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect((await request.get("/v/pipe0/public-docs.json")).status()).toBe(404);
  expect((await request.get("/v/pipe/public-docs.json")).status()).toBe(200);
});

test("a document that needs credentials", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "Connect another document" }).click();
  await page.getByLabel("OpenAPI document URL").fill(fixtureUrl("/private/openapi.json"));
  await page.getByRole("button", { name: "Connect" }).click();

  // Turned away: the app says so and offers the one field that fixes it.
  await expect(page.getByRole("alert")).toContainText("HTTP 401");
  await expect(page.getByLabel("Header name")).toHaveValue("Authorization");
  await shot(page, "07-credentials");
  await page.getByLabel("Value for Authorization").fill(`Bearer ${FIXTURE_TOKEN}`);
  await page.getByLabel("Value for Authorization").press("Enter");
  await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+\/new$/, { timeout: 30_000 });

  // Serve everything, take one tag out, and let later additions through.
  await page.getByLabel("Serve all operations", { exact: true }).click();
  await expect(page.getByTestId("served-operations")).toHaveText("30");
  await page.getByLabel("Secrets: serve all operations").click();
  await expect(page.getByTestId("served-operations")).toHaveText("24");
  await laterAre(page).getByRole("radio", { name: "Served" }).click();
  await expect(page.getByTestId("served-operations")).toHaveText("24");

  await page.getByLabel("Variant name").fill("Partners");
  await page.getByRole("button", { name: /Create variant/ }).click();
  await expect(page).toHaveURL(/\/v\/var_/);

  const served = await request.get("/v/pipe0/partners.json");
  expect(served.status()).toBe(200);
  expect(await served.text()).not.toContain("/v1/secrets");

  // The secret is stored, shown as stored, and never sent back to the browser.
  await page.getByRole("link", { name: "Sources" }).click();
  await expect(page.getByLabel("Header name")).toHaveValue("Authorization");
  await expect(page.getByLabel("Value for Authorization")).toHaveValue("");
  await expect(page.getByPlaceholder("Stored. Type to replace")).toBeVisible();
  expect(await (await page.request.get("/api/projects")).text()).not.toContain(FIXTURE_TOKEN);
});

test("keyboard: the command menu reaches everything", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pipe0 API");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search variants, projects and actions").fill("public");
  await shot(page, "08-command-menu");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Variant name")).toHaveValue("Public docs");
});

test("an expired session returns you to where you were", async ({ page, context }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Sources" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sources");
  const url = page.url();

  await context.clearCookies();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page).toHaveURL(/\/login\?from=/);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByLabel("Password").press("Enter");
  await expect(page).toHaveURL(url);
});

test("leaving with unpublished changes asks first; deleting takes the URL down", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Public docs/ })
    .click();
  await page.getByLabel("GET /v1/pipes/check/{run_id}", { exact: true }).click();
  await expect(page.getByText("Unpublished changes")).toBeVisible();

  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Leave without publishing?");
  await page.getByRole("button", { name: "Stay" }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("Unpublished changes")).toBeHidden();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete variant" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete variant" }).click();
  await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+$/);
  // "pipe0" was renamed to "pipe" by the settings test above.
  expect((await request.get("/v/pipe/public-docs.json")).status()).toBe(404);
});

test("merging a second document into a project, and serving a variant as OpenAPI 3.0", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "Sources" }).click();
  await page.getByRole("button", { name: "Add a document" }).click();
  await page.getByLabel("Another document").fill(fixtureUrl("/billing/openapi.json"));
  await page.getByLabel("Path prefix").fill("billing");
  await page.getByRole("button", { name: "Merge it in" }).click();

  // Both documents are listed, the first as the main one, and the merge says what it did.
  await expect(page.getByText("Billing API", { exact: true })).toBeVisible();
  await expect(page.getByText("Main document")).toBeVisible();
  await expect(page.getByText("under /billing")).toBeVisible();
  await expect(page.getByText("What merging changed")).toBeVisible();
  await expect(
    page.getByText(/bearerAuth of Billing API is served as BillingBearerAuth/),
  ).toBeVisible();
  await expect(page.getByText(/Billing API lists servers of its own/)).toBeVisible();
  await shot(page, "12-merged-sources");

  // Its operations are in the editor, under their prefix, marked with where they came from.
  await page.keyboard.press("n");
  await page.getByPlaceholder("Filter operations").fill("billing");
  await expect(page.getByLabel("GET /billing/invoices", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("GET /billing/invoices/{invoice_id}", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Serve all" }).click();
  await expect(page.getByTestId("served-operations")).toHaveText("2");

  // Served as OpenAPI 3.0: the preview shows the conversion before anything is published.
  await page.getByRole("button", { name: "OpenAPI version served" }).click();
  await page.getByRole("menuitemradio", { name: "3.0, converted" }).click();
  await expect(page.getByTestId("result-document")).toContainText('"openapi": "3.0.3"');
  await expect(page.getByTestId("result-document")).toContainText('"nullable": true');
  await shot(page, "13-merged-variant");

  await page.getByLabel("Variant name").fill("Billing for the gateway");
  await page.getByRole("button", { name: /Create variant/ }).click();
  await expect(page).toHaveURL(/\/v\/var_/);

  const response = await request.get("/v/pipe/billing-for-the-gateway.json");
  expect(response.status()).toBe(200);
  const served = (await response.json()) as {
    openapi: string;
    info: { title: string };
    paths: Record<string, unknown>;
    components: { securitySchemes: Record<string, unknown> };
  };
  expect(served.openapi).toBe("3.0.3");
  // The main document's title, the second document's operations, and the
  // security each document asks for: the second one's under the name it was given.
  expect(served.info.title).toBe("Pipe0 API");
  expect(Object.keys(served.paths)).toEqual([
    "/billing/invoices",
    "/billing/invoices/{invoice_id}",
  ]);
  expect(Object.keys(served.components.securitySchemes)).toEqual([
    "bearerAuth",
    "BillingBearerAuth",
  ]);
  expect(await response.text()).not.toContain("billing.internal");
});

test("the workspace: inviting a colleague", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Workspace" }).click();
  // The development server compiles this screen on its first visit, which can take a while.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workspace", {
    timeout: 20_000,
  });
  await expect(page.getByText("Owner", { exact: true })).toBeVisible();

  await page.getByLabel("Invite someone").fill("ada@example.com");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText("Invited by Admin, not joined yet")).toBeVisible();
  await shot(page, "09-workspace");

  // The invitation is a link. For whoever opens it while already inside, it says so.
  const workspace = (await (await page.request.get("/api/workspace")).json()) as {
    invitations: Array<{ email: string; link: string }>;
  };
  expect(workspace.invitations.map((invitation) => invitation.email)).toEqual(["ada@example.com"]);
  await page.goto(new URL(workspace.invitations[0]?.link as string).pathname);
  await expect(page.getByRole("heading", { name: /^You are in / })).toBeVisible();
  await page.getByRole("button", { name: "Open it" }).click();
  await expect(page).toHaveURL(/\/(p\/|connect)/);

  await page.getByRole("link", { name: "Workspace" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("ada@example.com")).toBeHidden();
});

test("on a phone: nothing overflows, and the navigation is one tap away", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const fits = () =>
    page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await fits()).toBe(true);
  await shot(page, "10-phone-overview");

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Workspace" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workspace");
  expect(await fits()).toBe(true);

  // The editor, on whatever project the earlier journeys left behind.
  const [project] = (await (await page.request.get("/api/projects")).json()) as Array<{
    id: string;
  }>;
  await page.goto(`/p/${project?.id}/new`);
  await expect(page.getByLabel("Variant name")).toBeVisible();
  await expect(page.getByLabel("Serve all operations", { exact: true })).toBeVisible();
  expect(await fits()).toBe(true);
  await shot(page, "11-phone-editor");
});
