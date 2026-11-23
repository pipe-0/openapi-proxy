import { expect, test } from "@playwright/test";
import { shot, signIn } from "./helpers.ts";

/**
 * A deploy API key, the way its owner meets it: made on the Workspace page,
 * shown once, used by a pipeline to apply a definition, and revoked.
 */
test("a deploy API key: created, shown once, used by a pipeline, revoked", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "Workspace" }).click();
  // The development server compiles this screen on its first visit, which can take a while.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workspace", {
    timeout: 20_000,
  });
  // The two kinds of key, each with what it is for.
  await expect(page.getByRole("heading", { name: "Deploy API keys" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "User API keys" })).toBeVisible();

  await page.getByLabel("New deploy API key").fill("Deploy pipeline");
  await page.getByRole("button", { name: "Create deploy API key" }).click();

  // Shown once, in full, with what to do with it.
  await expect(page.getByRole("heading", { name: "Your new API key" })).toBeVisible();
  const key = (await page.getByTestId("new-key").textContent()) ?? "";
  expect(key).toMatch(/^oap_[0-9a-z]{40}$/);
  await expect(page.getByText("OPENAPI_PROXY_API_KEY", { exact: false }).first()).toBeVisible();
  await shot(page, "12-new-key");
  await page.getByRole("button", { name: "Done" }).click();

  // Afterwards only its beginning is on the page.
  await expect(page.getByText("Deploy pipeline", { exact: true })).toBeVisible();
  await expect(page.getByText(`${key.slice(0, 8)}…, made by you, never used`)).toBeVisible();
  await expect(page.getByText(key)).toHaveCount(0);
  await shot(page, "13-api-keys", { fullPage: true });

  // A pipeline with the key, and nothing else: no cookies, no Origin. It
  // applies a definition (here only rehearsed), and that is all it does.
  const headers = { authorization: `Bearer ${key}` };
  const definition = {
    version: 1,
    project: "rehearsal",
    sources: [{ file: "./openapi.json" }],
    variants: { public: {} },
  };
  const document = {
    openapi: "3.1.0",
    info: { title: "Rehearsal", version: "1" },
    paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
  };
  const rehearsal = await request.put("/api/projects/rehearsal?dryRun=true", {
    headers,
    data: { definition, documents: { main: { content: JSON.stringify(document) } } },
  });
  expect(rehearsal.status()).toBe(200);
  expect(await rehearsal.json()).toMatchObject({ dryRun: true, created: true });
  expect((await request.get("/api/projects", { headers })).status()).toBe(403);
  expect((await request.get("/api/projects")).status()).toBe(401);

  // The page now knows the key has been used.
  await page.reload();
  await expect(page.getByText(/made by you, last used/)).toBeVisible();

  // Revoked: gone from the list, and dead.
  await page.getByRole("button", { name: "Revoke Deploy pipeline" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByText("Deploy pipeline", { exact: true })).toBeHidden();
  const after = await request.put("/api/projects/rehearsal?dryRun=true", {
    headers,
    data: { definition },
  });
  expect(after.status()).toBe(401);
});

/**
 * A private variant, the way its owner meets it: made private next to its
 * URL, read with a user API key made for it there, and opened again.
 */
test("a private variant: read with a key made for it, and by nobody else", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Billing for the gateway/ })
    .click();
  const url = "/v/pipe0/billing-for-the-gateway.json";
  expect((await request.get(url)).status()).toBe(200);

  await page.getByRole("button", { name: "Who can read it" }).click();
  await page.getByRole("menuitemradio", { name: /Private/ }).click();
  await expect(page.getByText(/Readers send an API key as/)).toBeVisible();
  // A browser sends no key, so there is nothing to open it with.
  await expect(page.getByRole("link", { name: "Open in a new tab" })).toBeHidden();
  await shot(page, "15-private-variant");
  const refused = await request.get(url);
  expect(refused.status()).toBe(401);
  expect(refused.headers()["www-authenticate"]).toBe("Bearer");

  // The key is made where it is needed, and reads this variant only.
  await page.getByRole("button", { name: "Create a key for this variant" }).click();
  await expect(page.getByRole("heading", { name: "Your new API key" })).toBeVisible();
  const key = (await page.getByTestId("new-key").textContent()) ?? "";
  expect(key).toMatch(/^oap_[0-9a-z]{40}$/);
  await expect(page.getByText(`curl -H "Authorization: Bearer ${key}"`)).toBeVisible();
  await shot(page, "16-key-for-a-variant");
  await page.getByRole("button", { name: "Done" }).click();

  const headers = { authorization: `Bearer ${key}` };
  const read = await request.get(url, { headers });
  expect(read.status()).toBe(200);
  expect(read.headers()["cache-control"]).toBe("private, no-cache");
  expect(
    (await request.get("/v/pipe0/billing-for-the-gateway/3.0.yaml", { headers })).status(),
  ).toBe(200);
  // It reads, and does nothing else.
  expect((await request.get("/api/projects", { headers })).status()).toBe(403);

  // The workspace says who reads a variant that does not say itself, and
  // every such variant follows at once: here, the one that was never set.
  const follower = "/v/pipe0/billing-staging.json";
  expect((await request.get(follower)).status()).toBe(200);
  await page.getByRole("link", { name: "Workspace" }).click();
  await expect(page.getByText(/Reads Pipe0 API \/ Billing for the gateway/)).toBeVisible();
  const variantsAre = page.getByRole("radiogroup", { name: "Variants are" });
  await expect(page.getByText(/variants? follows? this/)).toBeVisible();
  await shot(page, "17-default-visibility");
  await variantsAre.getByRole("radio", { name: "Private" }).click();
  await expect(
    page.getByText("Such a variant is read with a user API key of this workspace."),
  ).toBeVisible();
  await expect.poll(async () => (await request.get(follower)).status()).toBe(401);
  // A variant that says for itself is left alone, and a new one starts as the workspace says.
  await page.goBack();
  await page.keyboard.press("n");
  await expect(page.getByRole("button", { name: "Who can read it" })).toHaveText(/Private/);
  await page.getByRole("link", { name: "Workspace" }).click();
  // Opening variants to everyone is asked about first, with how many it is.
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toMatch(/^Make \d+ variants? public\?/);
    void dialog.accept();
  });
  await variantsAre.getByRole("radio", { name: "Public" }).click();
  await expect(page.getByText("Such a variant can be read by anyone with its URL.")).toBeVisible();
  await expect.poll(async () => (await request.get(follower)).status()).toBe(200);
  expect((await request.get(url)).status()).toBe(401);

  // Public again, after saying so: anyone with the URL reads it.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Billing for the gateway/ })
    .click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Who can read it" }).click();
  await page.getByRole("menuitemradio", { name: /Public/ }).click();
  await expect(page.getByText(/Readers send an API key as/)).toBeHidden();
  expect((await request.get(url)).status()).toBe(200);
});
