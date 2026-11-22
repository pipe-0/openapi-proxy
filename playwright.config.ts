import { defineConfig, devices } from "@playwright/test";
import { APP_PORT } from "./e2e/server.ts";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // One local database, one story at a time.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${APP_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/server.ts",
    url: `http://localhost:${APP_PORT}/api/auth-config`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
