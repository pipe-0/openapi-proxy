import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
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
