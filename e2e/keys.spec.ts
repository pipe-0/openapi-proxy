import { expect, test } from "@playwright/test";
import { shot, signIn } from "./helpers.ts";

/**
 * API keys, the way a person meets them: made in the Workspace page, shown
 * once, used by a program against the API and the MCP endpoint, and revoked.
 */
test("an API key: created, shown once, used by a program, revoked", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Workspace" }).click();
  // The development server compiles this screen on its first visit, which can take a while.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workspace", {
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  await page.getByLabel("New key").fill("Deploy pipeline");
  await page.getByRole("button", { name: "Create key" }).click();

  // Shown once, in full.
  await expect(page.getByRole("heading", { name: "Your new API key" })).toBeVisible();
  const key = (await page.getByTestId("new-key").textContent()) ?? "";
  expect(key).toMatch(/^oap_[0-9a-z]{40}$/);
  await shot(page, "12-new-key");
  await page.getByRole("button", { name: "Done" }).click();

  // Afterwards only its beginning is on the page.
  await expect(page.getByText("Deploy pipeline", { exact: true })).toBeVisible();
  await expect(page.getByText(`${key.slice(0, 8)}…, made by you, never used`)).toBeVisible();
  await expect(page.getByText(key)).toHaveCount(0);
  await shot(page, "13-api-keys");

  // A program with the key, and nothing else: no cookies, no Origin.
  const headers = { authorization: `Bearer ${key}` };
  const projects = await request.get("/api/projects", { headers });
  expect(projects.status()).toBe(200);
  expect(Array.isArray(await projects.json())).toBe(true);
  expect((await request.get("/api/projects")).status()).toBe(401);

  // The same key opens the MCP endpoint.
  const mcp = (body: object) =>
    request.post("/mcp", {
      headers: { ...headers, accept: "application/json, text/event-stream" },
      data: body,
    });
  const initialized = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1.0.0" },
    },
  });
  expect(initialized.status()).toBe(200);
  expect(await initialized.json()).toMatchObject({
    result: { protocolVersion: "2025-06-18", serverInfo: { name: "openapi-proxy" } },
  });
  const tools = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as {
    result: { tools: Array<{ name: string }> };
  };
  expect(tools.result.tools.map((tool) => tool.name)).toContain("create_variant");
  expect((await request.post("/mcp", { data: {} })).status()).toBe(401);

  // The page now knows the key has been used.
  await page.reload();
  await expect(page.getByText(/made by you, last used/)).toBeVisible();

  // Revoked: gone from the list, and dead.
  await page.getByRole("button", { name: "Revoke Deploy pipeline" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByText("Deploy pipeline", { exact: true })).toBeHidden();
  expect((await request.get("/api/projects", { headers })).status()).toBe(401);
  expect((await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" })).status()).toBe(401);
});

/**
 * A private variant, the way its owner meets it: made private next to its
 * URL, read with a key made for it there, and opened again.
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
  const url = "/v/pipe/billing-for-the-gateway.json";
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
    (await request.get("/v/pipe/billing-for-the-gateway/3.0.yaml", { headers })).status(),
  ).toBe(200);
  // It reads, and does nothing else.
  expect((await request.get("/api/projects", { headers })).status()).toBe(403);

  // A workspace can start every new variant private.
  await page.getByRole("link", { name: "Workspace" }).click();
  await expect(page.getByText(/Reads Pipe0 API \/ Billing for the gateway/)).toBeVisible();
  const newVariants = page.getByRole("radiogroup", { name: "New variants are" });
  await newVariants.getByRole("radio", { name: "Private" }).click();
  await expect(
    page.getByText("A new variant is read with an API key of this workspace."),
  ).toBeVisible();
  await page.goBack();
  await page.keyboard.press("n");
  await expect(page.getByRole("button", { name: "Who can read it" })).toHaveText(/Private/);
  await page.getByRole("link", { name: "Workspace" }).click();
  await newVariants.getByRole("radio", { name: "Public" }).click();
  await expect(page.getByText("A new variant can be read by anyone with its URL.")).toBeVisible();

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
