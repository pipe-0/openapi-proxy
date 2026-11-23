import { expect, test } from "@playwright/test";
import { shot, signIn } from "./helpers.ts";

/**
 * What a project says for all of its variants, and the two ways a project
 * exists: in the app, or as a file in a repository. Runs on the projects the
 * journeys before this one left behind.
 */
test.use({ viewport: { width: 1440, height: 900 } });

test("a project says what its variants are, unless they say otherwise", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto("/p/pipe0/settings");
  const defaults = page.locator("section", {
    has: page.getByRole("heading", { name: "Defaults for variants" }),
  });
  const who = defaults.getByRole("button", { name: "Who can read it" });
  // Nothing said yet: the workspace's default holds, and one variant follows it.
  await expect(who).toHaveText(/Public\s*by default/);
  await expect(
    defaults.getByText("1 variant follows this, and changes with it at once."),
  ).toBeVisible();
  const follower = "/v/pipe0/billing-staging.json";
  const explicit = "/v/pipe0/billing-for-the-gateway.json";
  expect((await request.get(follower)).status()).toBe(200);

  // The project says private. The variant that says nothing follows; the one that says public stays.
  await who.click();
  await page.getByRole("menuitemradio", { name: /Private/ }).click();
  await expect(who).toHaveText(/^Private$/);
  await expect.poll(async () => (await request.get(follower)).status()).toBe(401);
  expect((await request.get(explicit)).status()).toBe(200);

  // What readers see at the top of every variant, in place of what the document says.
  await defaults.getByRole("button", { name: /Title and servers/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("Pipe0, for partners");
  // On the project it is saved at once, and the button says so.
  await expect(
    page.getByText(/Saved at once, for every variant that does not set its own/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved for every variant that does not set its own")).toBeVisible();
  await expect
    .poll(
      async () =>
        ((await (await request.get(explicit)).json()) as { info: { title: string } }).info.title,
    )
    .toBe("Pipe0, for partners");
  await shot(page, "22-project-defaults", { fullPage: true });

  // A variant shows what it would inherit where it has nothing of its own, and says where from.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Billing for the gateway/ })
    .click();
  await page.getByRole("button", { name: /Title and servers/ }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveAttribute(
    "placeholder",
    "Pipe0, for partners",
  );
  await expect(
    page.getByText(/An empty field uses what the project says, and then what Pipe0 API says/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Billing staging/ })
    .click();
  await expect(page.getByRole("button", { name: "Who can read it" })).toHaveText(
    /Private\s*by default/,
  );

  // Back to saying nothing: opening variants to everyone is asked about first.
  await page.goto("/p/pipe0/settings");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toMatch(/^Make 1 variant public\?/);
    void dialog.accept();
  });
  await who.click();
  await page.getByRole("menuitemradio", { name: /Default/ }).click();
  await expect(who).toHaveText(/Public\s*by default/);
  await expect.poll(async () => (await request.get(follower)).status()).toBe(200);
  await defaults.getByRole("button", { name: /Title and servers/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      async () =>
        ((await (await request.get(explicit)).json()) as { info: { title: string } }).info.title,
    )
    .toBe("Pipe0 API");
});

test("a project made in the app is shown as the file that would make it", async ({ page }) => {
  await signIn(page);
  await page.goto("/p/pipe0/settings");
  await page.getByRole("button", { name: "View as file" }).click();
  const file = page.getByTestId("definition-file");
  await expect(file).toContainText("# yaml-language-server: $schema=");
  await expect(file).toContainText("project: pipe0");
  await expect(file).toContainText("name: Pipe0 API");
  // The service follows the URLs that were connected here, and the file says so.
  await expect(file).toContainText("follow: true");
  await expect(file).toContainText("pathPrefix: /billing");
  await expect(file).toContainText("billing-for-the-gateway:");
  // This instance is not the hosted service, so the file says where it is deployed.
  await expect(file).toContainText("instance: http://localhost:7733");
  await expect(
    page.getByText(/says what a deploy would change. For this file: nothing./),
  ).toBeVisible();
  await shot(page, "23-view-as-file");

  // What it shows is the definition the service holds.
  const held = (await (await page.request.get("/api/projects/pipe0")).json()) as {
    definition: { sources: Array<{ name: string }>; variants: Record<string, unknown> };
  };
  for (const source of held.definition.sources) {
    await expect(file).toContainText(`name: ${source.name}`);
  }
  for (const slug of Object.keys(held.definition.variants)) {
    await expect(file).toContainText(`${slug}:`);
  }
  await page.getByRole("button", { name: "Done" }).click();

  // It is also one click from any variant.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Billing staging/ })
    .click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "View as file" }).click();
  await expect(page.getByTestId("definition-file")).toContainText("project: pipe0");
});

test("a new project starts from a URL or from a repository, and both are offered alike", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "New project" }).click();
  const ways = page.getByRole("radiogroup", { name: "How the project is made" });
  await expect(ways.getByRole("radio", { name: "From a URL" })).toBeChecked();
  await expect(page.getByLabel("OpenAPI document URL")).toBeVisible();
  await expect(page.getByText(/The service reads it, keeps reading it/)).toBeVisible();

  await ways.getByRole("radio", { name: "From your repository" }).click();
  await expect(page.getByText(/written in a file next to your code/)).toBeVisible();
  await expect(page.getByText("npx @pipe0/openapi-proxy init ./openapi.json")).toBeVisible();
  await expect(page.getByText("npx @pipe0/openapi-proxy dev", { exact: true })).toBeVisible();
  // A self-hosted instance says what the file needs in order to be deployed to it.
  await expect(page.getByText("instance: http://localhost:7733")).toBeVisible();
  await shot(page, "24-from-your-repository");

  // The one thing only the app can make: the key the pipeline deploys with.
  await page.getByRole("button", { name: "Create a deploy API key" }).click();
  await expect(page.getByTestId("new-deploy-key")).toContainText(
    "This is the only time the key is shown.",
  );
  await expect(page.getByText(/^OPENAPI_PROXY_API_KEY=oap_[0-9a-z]{40} npx/)).toBeVisible();
  await page.getByRole("button", { name: "A workflow for GitHub Actions" }).click();
  await expect(page.getByText(/run: npx @pipe0\/openapi-proxy deploy/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy a prompt for your coding agent" }),
  ).toBeVisible();
  await shot(page, "25-from-your-repository-key", { fullPage: true });

  // It is a deploy API key of the workspace like any other, and is revoked there.
  await page.getByRole("link", { name: "Workspace" }).click();
  await page.getByRole("button", { name: "Revoke Deploy from CI" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByText("Deploy from CI", { exact: true })).toBeHidden();
});
