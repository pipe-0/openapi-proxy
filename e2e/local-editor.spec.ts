import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildCli, cli, root, shot } from "./helpers.ts";

/**
 * The editor that `openapi-proxy dev` serves, driven in a browser: the same
 * screen the app has for a variant, over a definition file in a folder. A
 * save is a change to that file, and the file is what the test ends on.
 */
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 } });

const PORT = 7747;
const here = `http://localhost:${PORT}`;
let dir = "";
let server: ChildProcess | undefined;
const file = () => join(dir, "openapi-proxy.yaml");
const text = () => readFileSync(file(), "utf8");
/** The lines of the file now that it did not have before, and the other way round. */
function changed(before: string) {
  const was = before.split("\n");
  const is = text().split("\n");
  return {
    removed: was.filter((line) => !is.includes(line)),
    added: is.filter((line) => !was.includes(line)),
  };
}

async function serve(port: number, ...flags: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [cli, "dev", "--port", String(port), ...flags], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: "ignore",
  });
  await expect
    .poll(
      async () =>
        (await fetch(`http://localhost:${port}/v/bookshop/docs.json`).catch(() => undefined))
          ?.status,
      { timeout: 15_000 },
    )
    .toBe(200);
  return child;
}

test.beforeAll(async () => {
  buildCli();
  // Two documents merged, four variants, and comments worth keeping.
  dir = mkdtempSync(join(tmpdir(), "openapi-proxy-editor-"));
  cpSync(join(root, "examples/several-audiences"), dir, { recursive: true });
  server = await serve(PORT);
});

test.afterAll(() => {
  server?.kill();
});

test("the file opens as a project: its variants, its operations, the document they produce", async ({
  page,
}) => {
  await page.goto(here);
  // It opens on the first variant of the file.
  await expect(page).toHaveURL(`${here}/#/v/docs`);
  await expect(page.getByLabel("Variant name")).toHaveValue("Public docs");
  const variants = page.getByRole("navigation", { name: "Variants" });
  await expect(variants.getByRole("link")).toHaveText([
    "Public docs",
    "SDK",
    "Catalogue partner",
    "Internal",
  ]);
  // Served from this machine, at the path the service has.
  await expect(page.getByTestId("variant-url")).toHaveText(`${here}/v/bookshop/docs.json`);
  // Both documents are in the picker, the second under its prefix.
  await expect(page.getByLabel("GET /books", { exact: true })).toBeChecked();
  await expect(
    page.getByLabel("POST /billing/invoices/{id}/refund", { exact: true }),
  ).not.toBeChecked();
  // What the project says for every variant is in the preview: its servers.
  await expect(page.getByTestId("result-document")).toContainText("https://api.bookshop.example");
  // Nothing here that only a service has.
  await expect(page.getByRole("button", { name: /Create a key/ })).toHaveCount(0);
  await shot(page, "20-local-editor");
});

test("a save changes the file where the selection changed, and nothing else", async ({
  page,
  request,
}) => {
  const before = text();
  await page.goto(`${here}/#/v/docs`);
  await page.getByLabel("POST /billing/invoices/{id}/refund", { exact: true }).click();
  await page.getByLabel("GET /billing/invoices", { exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  // Nothing is written until it is saved.
  expect(text()).toBe(before);
  await shot(page, "21-local-editor-unsaved");
  await page.getByRole("button", { name: /Save to file/ }).click();
  await expect(page.getByText("Saved to the file")).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toBeHidden();

  // The refund is no longer excluded, the list of invoices is, and every comment is where it was.
  expect(changed(before)).toEqual({
    removed: ["        - POST /billing/invoices/{id}/refund"],
    added: ["        - GET /billing/invoices"],
  });
  expect(text()).toContain(
    "  # The public reference: no staff routes, and refunds are not for everyone.\n  docs:",
  );
  // And it is what the local URL serves, at once.
  const served = (await (await request.get(`${here}/v/bookshop/docs.json`)).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  expect(Object.keys(served.paths["/billing/invoices/{id}/refund"] ?? {})).toEqual(["post"]);
  expect(served.paths["/billing/invoices"]).toBeUndefined();
});

test("a new variant, who may read it, and a change made to the file somewhere else", async ({
  page,
  request,
}) => {
  const before = text();
  await page.goto(`${here}/#/v/docs`);
  await page.getByRole("button", { name: "New variant" }).click();
  await expect(page).toHaveURL(`${here}/#/new`);
  await page.getByLabel("Variant name").fill("Checkout");
  await expect(page.getByLabel("URL slug")).toHaveValue("checkout");
  await page.getByLabel("Orders: serve all operations").click();
  // The file says its variants are private unless they say otherwise.
  const who = page.getByRole("button", { name: "Who can read it" });
  await expect(who).toHaveText(/Private\s*by default/);
  await page.getByRole("button", { name: /Create variant/ }).click();
  // It opens on the new variant. That it is new is said once, and does not stay in the address.
  await expect(page).toHaveURL(`${here}/#/v/checkout`);
  await expect(
    page.getByRole("navigation", { name: "Variants" }).getByRole("link", { name: "Checkout" }),
  ).toBeVisible();
  expect(changed(before)).toEqual({
    removed: [],
    added: ["  checkout:", "    name: Checkout", "      tags: [Orders]"],
  });
  expect((await request.get(`${here}/v/bookshop/checkout.json`)).status()).toBe(200);

  // Saying who reads it is saved the moment it is said, as in the app.
  page.once("dialog", (dialog) => void dialog.accept());
  await who.click();
  await page.getByRole("menuitemradio", { name: /Public/ }).click();
  await expect(who).toHaveText(/^Public$/);
  await expect.poll(text).toContain("  checkout:\n    name: Checkout\n    visibility: public\n");

  // The file is also edited by hand. Coming back to the page shows what it says now.
  writeFileSync(file(), text().replace("    name: Checkout\n", "    name: Checkout flow\n"));
  await page.reload();
  await expect(page.getByLabel("Variant name")).toHaveValue("Checkout flow");

  // Taking it out again leaves the file as it was before this test.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete variant" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete variant" }).click();
  await expect(page).toHaveURL(`${here}/#/v/docs`);
  expect(text()).toBe(before);
});

test("what is not saved stays on the screen when the file changes or cannot be read", async ({
  page,
}) => {
  const before = text();
  await page.goto(`${here}/#/v/partner`);
  await page.getByLabel("POST /orders", { exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // The file is edited by hand meanwhile. Coming back to the page says so, and keeps the draft.
  writeFileSync(file(), before.replace("name: Catalogue partner", "name: Catalogue partners"));
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByText("The file was changed somewhere else.")).toBeVisible();
  await expect(page.getByLabel("POST /orders", { exact: true })).toBeChecked();
  await shot(page, "26-local-editor-file-changed");
  // Saving would write over what was done there, and is refused.
  await page.getByRole("button", { name: /Save to file/ }).click();
  await expect(page.getByText(/was changed in the meantime/)).toBeVisible();
  expect(text()).toContain("name: Catalogue partners");
  expect(text()).not.toContain("- POST /orders");

  // The file becomes unreadable while it is being edited by hand. The draft is still there.
  writeFileSync(file(), `${text()}\n  broken: [`);
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByLabel("POST /orders", { exact: true })).toBeChecked();
  writeFileSync(file(), before.replace("name: Catalogue partner", "name: Catalogue partners"));
  await page.evaluate("window.dispatchEvent(new Event('focus'))");

  // Reading the file again is a decision: it shows what the file says, without the draft.
  await page.getByRole("button", { name: "Read the file again" }).click();
  await expect(page.getByLabel("Variant name")).toHaveValue("Catalogue partners");
  await expect(page.getByLabel("POST /orders", { exact: true })).not.toBeChecked();
  await expect(page.getByText("Unsaved changes")).toBeHidden();

  // The browser's Back does not walk away from unsaved work without asking.
  await page
    .getByRole("navigation", { name: "Variants" })
    .getByRole("link", { name: "SDK" })
    .click();
  await expect(page).toHaveURL(`${here}/#/v/sdk`);
  await page.getByLabel("POST /orders", { exact: true }).click();
  // An icon is saved the moment it is picked. The selection is still not
  // saved, so it stays as it is on screen, and leaving still asks.
  await page.getByRole("button", { name: "Variant icon" }).click();
  await page.getByRole("menuitem", { name: "Production" }).click();
  await expect.poll(() => text()).toContain("icon: rocket");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByLabel("POST /orders", { exact: true })).not.toBeChecked();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page
    .getByRole("navigation", { name: "Variants" })
    .getByRole("link", { name: /Catalogue partner/ })
    .click();
  await expect(page).toHaveURL(`${here}/#/v/sdk`);
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(`${here}/#/v/sdk`);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();

  // What a variant says at the top is saved into the file like its selection.
  await page.getByRole("button", { name: /Title and servers/ }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Bookshop SDK");
  // What the project says for every variant is what an empty field stands for.
  await expect(page.getByText("As the project says: https://api.bookshop.example")).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Bookshop SDK, v2");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: /Save to file/ }).click();
  await expect(page.getByText("Saved to the file")).toBeVisible();
  expect(text()).toContain("      title: Bookshop SDK, v2\n");

  writeFileSync(file(), before);
});

test("only the page changes the file, and without it nothing does", async ({ request }) => {
  const project = (await (await request.get(`${here}/api/projects/bookshop`)).json()) as {
    definition: object;
    state: { revision: number; can: object; defaultVisibility: unknown };
  };
  expect(project.state.can).toEqual({ edit: true, credentials: false, keys: false, check: false });
  expect(project.state.defaultVisibility).toBeNull();
  const before = text();
  const body = JSON.stringify({ definition: { ...project.definition, name: "Taken over" } });
  const put = (headers: Record<string, string>) =>
    fetch(`${here}/api/projects/bookshop`, { method: "PUT", headers, body });

  // A page on another site, however it words it.
  const attempts: Array<Record<string, string>> = [
    { "content-type": "application/json", origin: "https://evil.example" },
    { "content-type": "text/plain", origin: here },
    { "content-type": "application/json" },
  ];
  for (const headers of attempts) {
    expect((await put(headers)).status).toBe(403);
  }
  // A name that points at this machine is not this machine's name: a page on
  // such a domain could otherwise read what is served here.
  const rebound = await new Promise<number>((resolve, reject) => {
    get(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/api/projects",
        headers: { host: "attacker.example" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    ).on("error", reject);
  });
  expect(rebound).toBe(403);
  // A save that started from an older file is told so, and writes nothing.
  const stale = await fetch(`${here}/api/projects/bookshop`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: here },
    body: JSON.stringify({ definition: project.definition, ifRevision: 1 }),
  });
  expect(stale.status).toBe(409);
  expect(text()).toBe(before);

  // Started without the editor, the server serves variants and has nothing that writes.
  const plain = await serve(PORT + 1, "--no-editor");
  try {
    const there = `http://localhost:${PORT + 1}`;
    expect((await fetch(`${there}/v/bookshop/docs.json`)).status).toBe(200);
    expect((await fetch(there)).status).toBe(404);
    expect((await fetch(`${there}/api/projects`)).status).toBe(404);
    const refused = await fetch(`${there}/api/projects/bookshop`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: there },
      body,
    });
    expect([403, 404]).toContain(refused.status);
  } finally {
    plain.kill();
  }
  expect(text()).toBe(before);
});
