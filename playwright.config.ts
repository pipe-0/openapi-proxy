import { defineConfig, devices } from "@playwright/test";
import { APP_PORT } from "./e2e/server.ts";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // The development server compiles a page on its first visit. On a CI machine
  // that can take longer than the five seconds an expectation waits by default.
  expect: { timeout: process.env.CI ? 20_000 : 5_000 },
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
    // On CI the server's own output is part of the log: when a journey fails
    // there, what the server was doing at that moment is the first question.
    stdout: process.env.CI ? "pipe" : "ignore",
  },
});
