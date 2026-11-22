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
  page.getByRole("radiogroup", { name: "Operations your API adds later are" });

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

  // A whole tag is one click, and covers what is added to it later; single operations are pinned.
  await page.getByLabel("Search: serve all operations").click();
  await expect(
    page.getByRole("checkbox", { name: "Search: serve operations added later" }),
  ).toBeChecked();
  // The switch at the foot names the tag that is the exception to it.
  await expect(page.getByText("Except in Search, where they are served.")).toBeVisible();
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

  // ---- An icon tells it apart in the navigation, and is saved as it is picked ----
  const inNavigation = page.getByRole("link", { name: "Public docs" });
  await expect(inNavigation.locator('[data-icon="file"]')).toBeVisible();
  await page.getByRole("button", { name: "Variant icon" }).click();
  await expect(page.getByRole("menuitem", { name: "Docs" })).toBeVisible();
  await shot(page, "04-icon-picker");
  await page.getByRole("menuitem", { name: "Docs" }).click();
  await expect(inNavigation.locator('[data-icon="book"]')).toBeVisible();
  await page.reload();
  await expect(inNavigation.locator('[data-icon="book"]')).toBeVisible();

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

  // ---- It is in the navigation, on every page of the project ----
  await page.getByRole("link", { name: "Project settings" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Project settings");
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Public docs/ }),
  ).toBeVisible();
});

test("a project's documents: version endpoint and URL prefix", async ({ page, request }) => {
  // A project opens on its documents.
  await signIn(page);
  await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+\/settings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Project settings");
  await expect(page.getByText("We check this document for updates every hour.")).toBeVisible();
  await shot(page, "06-source");

  // The documents are a list. A document's settings open beside it.
  await expect(page.getByRole("cell", { name: "Full download" })).toBeVisible();
  await page.getByRole("button", { name: "Pipe0 API", exact: true }).click();
  await shot(page, "06-source-settings");

  // An endpoint that reports nothing is refused, with the reason.
  await page.getByLabel("Version endpoint").fill(fixtureUrl("/nothing-here"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No version could be read");

  // Saved: the sheet closes, and the list says how this document is checked now.
  await page.getByLabel("Version endpoint").fill(fixtureUrl("/version"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Version endpoint" })).toBeVisible();
  await page.getByRole("button", { name: "Pipe0 API", exact: true }).click();
  await expect(page.getByText("x-api-version: 1")).toBeVisible();
  await page.keyboard.press("Escape");

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
  await page.getByRole("menuitem", { name: "New project" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New project");
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
  await page.getByRole("link", { name: "Project settings" }).click();
  await page.getByRole("table").getByRole("button").first().click();
  await expect(page.getByLabel("Header name")).toHaveValue("Authorization");
  await expect(page.getByLabel("Value for Authorization")).toHaveValue("");
  await expect(page.getByPlaceholder("Stored. Type to replace")).toBeVisible();
  expect(await (await page.request.get("/api/projects")).text()).not.toContain(FIXTURE_TOKEN);
});

test("keyboard: the command menu reaches everything", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Project settings");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search variants, projects and actions").fill("public");
  await shot(page, "08-command-menu");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Variant name")).toHaveValue("Public docs");
});

test("an expired session returns you to where you were", async ({ page, context }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Project settings" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Project settings");
  const url = page.url();

  await context.clearCookies();
  await page.getByRole("button", { name: "Check for updates now" }).click();
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

  await page.getByRole("link", { name: "Project settings" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Leave without publishing?");
  await page.getByRole("button", { name: "Stay" }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("Unpublished changes")).toBeHidden();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete variant" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete variant" }).click();
  await expect(page).toHaveURL(/\/p\/prj_[a-z0-9]+\/settings$/);
  // "pipe0" was renamed to "pipe" by the settings test above.
  expect((await request.get("/v/pipe/public-docs.json")).status()).toBe(404);
});

test("merging a second document into a project, and serving a variant as OpenAPI 3.0", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "Project settings" }).click();
  await page.getByRole("button", { name: "Add document" }).click();
  await page.getByLabel("Document URL").fill(fixtureUrl("/billing/openapi.json"));
  await page.getByLabel("Path prefix").fill("billing");
  await page.getByRole("button", { name: "Merge it in" }).click();

  // Both documents are listed, the first as the main one, and the merge says what it did.
  const documents = page.getByRole("table");
  await expect(documents.getByRole("button", { name: "Billing API", exact: true })).toBeVisible();
  await expect(documents.getByText("Main", { exact: true })).toBeVisible();
  await expect(documents.getByText("/billing", { exact: true })).toBeVisible();
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

  // Every variant is served in each OpenAPI version. The preview shows any of them.
  await page.getByRole("button", { name: "OpenAPI version" }).click();
  await page.getByRole("menuitemradio", { name: /3\.0, converted/ }).click();
  await expect(page.getByTestId("result-document")).toContainText('"openapi": "3.0.3"');
  await expect(page.getByTestId("result-document")).toContainText('"nullable": true');
  await shot(page, "13-merged-variant");

  await page.getByLabel("Variant name").fill("Billing for the gateway");
  await page.getByRole("button", { name: /Create variant/ }).click();
  await expect(page).toHaveURL(/\/v\/var_/);

  // At its URL it is what the API has, and the URL follows the version that is picked.
  await expect(page.getByTestId("variant-url")).toHaveText(
    /\/v\/pipe\/billing-for-the-gateway\.json$/,
  );
  expect(
    (
      (await (await request.get("/v/pipe/billing-for-the-gateway.json")).json()) as {
        openapi: string;
      }
    ).openapi,
  ).toBe("3.1.0");
  await page.getByRole("button", { name: "OpenAPI version" }).click();
  // Each version says where it is served.
  await expect(page.getByRole("menuitemradio", { name: /3\.1, as your API has it/ })).toContainText(
    "/v/pipe/billing-for-the-gateway.json",
  );
  await expect(page.getByRole("menuitemradio", { name: /3\.0, converted/ })).toContainText(
    "/v/pipe/billing-for-the-gateway/3.0.json",
  );
  await page.getByRole("menuitemradio", { name: /3\.0, converted/ }).click();
  await expect(page.getByTestId("variant-url")).toHaveText(
    /\/v\/pipe\/billing-for-the-gateway\/3\.0\.json$/,
  );

  const response = await request.get("/v/pipe/billing-for-the-gateway/3.0.json");
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

test("a variant for another environment: duplicate it, and state its own servers", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Billing for the gateway/ })
    .click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();

  // The copy starts with the same operations, not yet named.
  await expect(page).toHaveURL(/\/new\?from=var_/);
  await expect(page.getByTestId("served-operations")).toHaveText("2");
  await expect(page.getByTestId("result-document")).toContainText('"openapi": "3.1.0"');

  await page.getByRole("button", { name: /Title and servers/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("Billing, staging");
  await page.getByRole("button", { name: /Change the servers|Add server/ }).click();
  await page.getByLabel("Server 1 URL").fill("staging.example.com");
  await expect(page.getByRole("alert")).toContainText("starts with https://");
  await page.getByLabel("Server 1 URL").fill("https://staging.example.com");
  await page.getByLabel("Server 1 description").fill("Staging");
  await shot(page, "14-title-and-servers");
  await page.getByRole("button", { name: "Done" }).click();
  // The preview is the served document, with what this variant says at the top.
  await expect(page.getByTestId("result-document")).toContainText("https://staging.example.com");

  await page.getByLabel("Variant name").fill("Billing staging");
  await page.getByRole("button", { name: /Create variant/ }).click();
  await expect(page).toHaveURL(/\/v\/var_/);

  const staging = (await (await request.get("/v/pipe/billing-staging.json")).json()) as {
    info: { title: string };
    servers: Array<{ url: string; description?: string }>;
  };
  expect(staging.info.title).toBe("Billing, staging");
  expect(staging.servers[0]).toEqual({
    url: "https://staging.example.com",
    description: "Staging",
  });
  // The variant it was copied from still says what the document says.
  const original = (await (await request.get("/v/pipe/billing-for-the-gateway.json")).json()) as {
    info: { title: string };
  };
  expect(original.info.title).toBe("Pipe0 API");
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

  // Billing: the plan, how much of it is in use, and how to change it.
  const billing = page.locator("section", {
    has: page.getByRole("heading", { name: "Billing" }),
  });
  await expect(billing.getByText("Free", { exact: true })).toBeVisible();
  await expect(billing.getByText(/^\d of 3$/)).toBeVisible();
  await expect(billing.getByText(/^\d+ of 15$/)).toBeVisible();
  // This instance sends no email of its own, so the request is a letter from the owner.
  await expect(billing.locator('a[href^="mailto:hello@example.com"]')).toHaveText(
    "Request upgrade to Pro",
  );
  await expect(billing.getByText("Opens an email to hello@example.com.")).toBeVisible();
  // Where plans are sold, the navigation says which one this is.
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Workspace/ }),
  ).toContainText("Free");
  await shot(page, "09-workspace", { fullPage: true });

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
  await shot(page, "10-phone-documents");

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
