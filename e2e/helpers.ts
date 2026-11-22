import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { ADMIN_PASSWORD, FIXTURE_PORT } from "./server.ts";

export const fixtureUrl = (path: string) => `http://127.0.0.1:${FIXTURE_PORT}${path}`;

export async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByLabel("Password").press("Enter");
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Save a screenshot when SCREENSHOTS_DIR is set. Lets the same journey that
 * tests the product also produce the images for the README and for design
 * review, in both color schemes.
 */
export async function shot(
  page: Page,
  name: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  const dir = process.env.SCREENSHOTS_DIR;
  if (!dir) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(dir, `${name}-${scheme}.png`), ...options });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * Follow a link to a page, and make sure of having arrived. The development
 * server compiles a page the first time it is opened and may reload the
 * browser while it does; a click that lands in that moment is lost, and the
 * page stays where it was. So the click is made again until the address is
 * the one the link leads to. Seen on CI, where every run starts cold.
 */
export async function follow(page: Page, link: Locator, path: string): Promise<void> {
  await expect(async () => {
    if (new URL(page.url()).pathname !== path) await link.click({ timeout: 3_000 });
    await expect(page).toHaveURL(path, { timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
}
