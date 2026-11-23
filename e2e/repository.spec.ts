import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildCli, cli, root, shot, signIn } from "./helpers.ts";
import { APP_PORT } from "./server.ts";

/**
 * A project that lives in a repository, end to end and for real: the command
 * line tool as it is built, a definition file in a folder, and the app this
 * suite runs. Nothing is stood in for.
 *
 * It follows the story of the guide: rehearse, deploy, serve the same on
 * localhost, change the file and deploy again, and meet the project in the
 * app, where it is read and not edited.
 */
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 } });

const LOCAL_PORT = 7746;
const instance = `http://localhost:${APP_PORT}`;

let dir = "";
let key = "";
let local: ChildProcess | undefined;

const file = () => join(dir, "openapi-proxy.yaml");
/** Run the command line tool in the repository folder, as a pipeline would. */
function run(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, OPENAPI_PROXY_API_KEY: key, NO_COLOR: "1", GITHUB_ACTIONS: "" },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test.beforeAll(() => {
  buildCli();

  // A repository: the example from the guide, deploying to this suite's instance.
  dir = mkdtempSync(join(tmpdir(), "openapi-proxy-e2e-"));
  cpSync(join(root, "examples/in-your-repository"), dir, { recursive: true });
  writeFileSync(file(), `${readFileSync(file(), "utf8")}\ninstance: ${instance}\n`);
});

test.afterAll(() => {
  local?.kill();
});

test("a deploy API key, a rehearsal, and the first deploy", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Workspace" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workspace", {
    timeout: 20_000,
  });
  await page.getByLabel("New deploy API key").fill("Bookshop pipeline");
  await page.getByRole("button", { name: "Create deploy API key" }).click();
  key = (await page.getByTestId("new-key").textContent()) ?? "";
  expect(key).toMatch(/^oap_[0-9a-z]{40}$/);
  await page.getByRole("button", { name: "Done" }).click();

  // Without the key there is nothing to deploy with, and the tool says where one comes from.
  const keyless = spawnSync(process.execPath, [cli, "deploy"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, OPENAPI_PROXY_API_KEY: "", NO_COLOR: "1" },
  });
  expect(keyless.status).toBe(1);
  expect(keyless.stderr).toContain("OPENAPI_PROXY_API_KEY is not set");

  // A rehearsal says what would happen, and nothing does.
  const rehearsal = run("deploy", "--dry-run");
  expect(rehearsal.status, rehearsal.err).toBe(0);
  expect(rehearsal.out).toContain(`Dry run: ${instance} would create bookshop.`);
  expect((await request.get("/v/bookshop/public.json")).status()).toBe(404);

  const first = run("deploy");
  expect(first.status, first.err).toBe(0);
  expect(first.out).toContain(`Created bookshop on ${instance}`);
  expect(first.out).toMatch(/main\s+uploaded\s+\S+ kB\s+8 operations\s+read from .*openapi\.json/);
  expect(first.out).toMatch(
    new RegExp(
      `public\\s+created\\s+5 of 8 operations\\s+public \\(set on the variant\\)\\s+${instance}/v/bookshop/public`,
    ),
  );

  const served = await request.get("/v/bookshop/public.json");
  expect(served.status()).toBe(200);
  const doc = (await served.json()) as {
    paths: Record<string, unknown>;
    servers: Array<{ url: string }>;
  };
  expect(Object.keys(doc.paths)).not.toContain("/orders/export");
  expect(doc.servers).toEqual([{ url: "https://api.bookshop.example" }]);
});

test("localhost serves the same bytes as the service, in every format and version", async ({
  request,
}) => {
  local = spawn(process.execPath, [cli, "dev", "--port", String(LOCAL_PORT)], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: "ignore",
  });
  const here = `http://localhost:${LOCAL_PORT}`;
  await expect
    .poll(
      async () => (await fetch(`${here}/v/bookshop/public.json`).catch(() => undefined))?.status,
      {
        timeout: 15_000,
      },
    )
    .toBe(200);

  for (const representation of [
    ".json",
    ".yaml",
    "/3.0.json",
    "/3.0.yaml",
    "/3.1.json",
    "/3.1.yaml",
  ]) {
    const path = `/v/bookshop/public${representation}`;
    const deployed = await request.get(path);
    const onLocalhost = await fetch(`${here}${path}`);
    expect(deployed.status(), path).toBe(200);
    expect(onLocalhost.status, path).toBe(200);
    expect(await onLocalhost.text(), path).toBe(await deployed.text());
    expect(onLocalhost.headers.get("content-type"), path).toBe(deployed.headers()["content-type"]);
  }
  // And says the same about what is not there.
  expect((await fetch(`${here}/v/bookshop/nope.json`)).status).toBe(404);
  expect((await request.get("/v/bookshop/nope.json")).status()).toBe(404);
});

test("the file changes and is deployed again: the variant stays the same variant", async ({
  page,
  request,
}) => {
  await signIn(page);
  const view = async () =>
    (await (await page.request.get("/api/projects/bookshop")).json()) as {
      state: { managedBy: string; variants: Record<string, { id: string }> };
    };

  // A second variant, private, and a user API key that reads it alone.
  writeFileSync(
    file(),
    readFileSync(file(), "utf8").replace(
      "variants:\n",
      "variants:\n  partners:\n    visibility: private\n    include:\n      tags: [Orders]\n",
    ),
  );
  const second = run("deploy");
  expect(second.status, second.err).toBe(0);
  expect(second.out).toMatch(
    /partners\s+created\s+3 of 8 operations\s+private \(set on the variant\)/,
  );
  expect(second.out).toMatch(/public\s+unchanged/);
  const before = await view();
  const made = await page.request.post("/api/workspace/keys", {
    data: {
      name: "Partner",
      access: "read",
      variant: { project: "bookshop", variant: "partners" },
    },
  });
  const reader = { authorization: `Bearer ${((await made.json()) as { key: string }).key}` };
  expect((await request.get("/v/bookshop/partners.json")).status()).toBe(401);
  expect((await request.get("/v/bookshop/partners.json", { headers: reader })).status()).toBe(200);

  // Its selection changes. It is the same variant: the same id, and the key still reads it.
  writeFileSync(
    file(),
    readFileSync(file(), "utf8").replace("tags: [Orders]", "tags: [Orders, Books]"),
  );
  const third = run("deploy");
  expect(third.status, third.err).toBe(0);
  expect(third.out).toMatch(/partners\s+changed\s+6 of 8 operations/);
  expect((await view()).state.variants.partners?.id).toBe(before.state.variants.partners?.id);
  const read = await request.get("/v/bookshop/partners.json", { headers: reader });
  expect(read.status()).toBe(200);
  expect(Object.keys(((await read.json()) as { paths: object }).paths)).toContain("/books");

  // Taken out of the file, it is gone, and so is the key that was for it alone.
  writeFileSync(
    file(),
    readFileSync(file(), "utf8").replace(
      "  partners:\n    visibility: private\n    include:\n      tags: [Orders, Books]\n",
      "",
    ),
  );
  const fourth = run("deploy");
  expect(fourth.status, fourth.err).toBe(0);
  expect(fourth.out).toMatch(/partners\s+deleted\s+1 user API key for it removed/);
  expect((await request.get("/v/bookshop/partners.json", { headers: reader })).status()).toBe(404);
  expect((await request.get("/v/bookshop/public.json")).status()).toBe(200);
});

test("in the app it is read, not edited, until someone says otherwise", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto("/p/bookshop/settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Project settings");

  // What defines it, and who deployed it last.
  await expect(page.getByText("This project is deployed from a file.")).toBeVisible();
  await expect(page.getByText(/with the deploy API key Bookshop pipeline/)).toBeVisible();
  // Its document was uploaded: there is nothing for the service to check.
  await expect(
    page.getByText(/uploaded .*, and stays as it is until the next deploy/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Check for updates now/ })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add document" })).toBeHidden();
  await shot(page, "18-deployed-project");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Public docs/ })
    .click();
  await expect(page.getByText("Deployed from a file", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Publish changes/ })).toBeHidden();
  await expect(page.getByLabel("Variant name")).toHaveAttribute("readonly", "");
  // Nothing on it changes the selection: not a box, and not the row around it.
  await expect(page.getByTestId("served-operations")).toHaveText("5");
  await page.getByText("/admin/staff").click();
  await page.getByLabel("DELETE /admin/cache", { exact: true }).click({ force: true });
  await expect(page.getByTestId("served-operations")).toHaveText("5");
  // So there is nothing to lose by leaving, and nothing asks.
  await page.getByRole("link", { name: "Project settings" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Project settings");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Public docs/ })
    .click();
  // Starting a variant is not offered either, by button or by key.
  await expect(page.getByRole("button", { name: "New variant" })).toHaveCount(0);
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/\/p\/bookshop\/v\/public$/);
  await shot(page, "19-deployed-variant");

  // Not through the back door either.
  const current = (await (await page.request.get("/api/projects/bookshop")).json()) as {
    definition: object;
  };
  const refused = await page.request.put("/api/projects/bookshop", {
    data: { definition: { ...current.definition, name: "Edited in the app" } },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "managed-by-file" });

  // One switch makes it the app's.
  await page.getByRole("button", { name: "Edit in the app instead" }).click();
  await expect(page.getByText("Deployed from a file", { exact: true })).toBeHidden();
  // It carries two tags, so it is listed under both. Either box is the same operation.
  await page.getByLabel("GET /orders/export", { exact: true }).first().click();
  await expect(page.getByText("Unpublished changes")).toBeVisible();
  await page.getByRole("button", { name: /Publish changes/ }).click();
  await expect(page.getByText("Unpublished changes")).toBeHidden();
  const doc = (await (await request.get("/v/bookshop/public.json")).json()) as { paths: object };
  expect(Object.keys(doc.paths)).toContain("/orders/export");

  // And the next deploy makes it the file's again: what the file says is what is served.
  const again = run("deploy");
  expect(again.status, again.err).toBe(0);
  expect(again.err).toContain(
    "This project was edited in the app. It is now defined by this file.",
  );
  const restored = (await (await request.get("/v/bookshop/public.json")).json()) as {
    paths: object;
  };
  expect(Object.keys(restored.paths)).not.toContain("/orders/export");

  // Deleting it works from the app. The journeys after this one want the room.
  await page.goto("/p/bookshop/settings");
  await page.getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "The next deploy of its file would create it again.",
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete project" }).click();
  await expect(page).not.toHaveURL(/bookshop/);
  expect((await request.get("/v/bookshop/public.json")).status()).toBe(404);
});
