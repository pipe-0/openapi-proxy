import { expect, test } from "@playwright/test";
import { shot, signIn } from "./helpers.ts";

/**
 * API tokens, the way a person meets them: made in the Workspace page, shown
 * once, used by a program against the API and the MCP endpoint, and revoked.
 */
test("an API token: created, shown once, used by a program, revoked", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Workspace" }).click();
  // The development server compiles this screen on its first visit, which can take a while.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workspace", {
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();

  await page.getByLabel("New token").fill("Deploy pipeline");
  await page.getByRole("button", { name: "Create token" }).click();

  // Shown once, in full.
  await expect(page.getByRole("heading", { name: "Your new token" })).toBeVisible();
  const token = (await page.getByTestId("new-token").textContent()) ?? "";
  expect(token).toMatch(/^oap_[0-9a-z]{40}$/);
  await shot(page, "12-new-token");
  await page.getByRole("button", { name: "Done" }).click();

  // Afterwards only its beginning is on the page.
  await expect(page.getByText("Deploy pipeline", { exact: true })).toBeVisible();
  await expect(page.getByText(`${token.slice(0, 8)}…, made by you, never used`)).toBeVisible();
  await expect(page.getByText(token)).toHaveCount(0);
  await shot(page, "13-api-tokens");

  // A program with the token, and nothing else: no cookies, no Origin.
  const headers = { authorization: `Bearer ${token}` };
  const projects = await request.get("/api/projects", { headers });
  expect(projects.status()).toBe(200);
  expect(Array.isArray(await projects.json())).toBe(true);
  expect((await request.get("/api/projects")).status()).toBe(401);

  // The same token opens the MCP endpoint.
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

  // The page now knows the token has been used.
  await page.reload();
  await expect(page.getByText(/made by you, last used/)).toBeVisible();

  // Revoked: gone from the list, and dead.
  await page.getByRole("button", { name: "Revoke Deploy pipeline" }).click();
  await page.getByRole("button", { name: "Revoke token" }).click();
  await expect(page.getByText("Deploy pipeline", { exact: true })).toBeHidden();
  expect((await request.get("/api/projects", { headers })).status()).toBe(401);
  expect((await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" })).status()).toBe(401);
});
