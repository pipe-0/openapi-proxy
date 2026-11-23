/**
 * Everything the end-to-end suite needs, in one process:
 *
 * - a fixture server standing in for "your backend": it serves the reference
 *   spec publicly and behind a bearer token;
 * - the app itself (Vite + the Worker in workerd) on a fresh, migrated local
 *   database that lives apart from normal development data.
 *
 * Nothing here talks to the internet, so the suite is deterministic.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_PORT = 7733;
export const FIXTURE_PORT = 7734;
export const FIXTURE_TOKEN = "e2e-token";
/** Whether the suite runs against `vite preview` (the production build) instead of `vite dev`. */
export const PREVIEW = process.env.E2E_PREVIEW === "1";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = join(appDir, ".wrangler", "e2e");
const spec = readFileSync(join(appDir, "packages/core/test/fixtures/pipe0.json"));

/**
 * A second service of the same company, to be merged with the first. It
 * defines one operation the main document also has, and a security scheme of
 * the same name that means something else.
 */
const billing = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Billing API", version: "2.0.0" },
  servers: [{ url: "https://billing.internal" }],
  tags: [{ name: "Invoices" }],
  paths: {
    "/invoices": {
      get: {
        tags: ["Invoices"],
        summary: "List invoices",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "The invoices",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } },
          },
        },
      },
    },
    "/invoices/{invoice_id}": {
      get: {
        tags: ["Invoices"],
        summary: "Get an invoice",
        parameters: [
          { name: "invoice_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "The invoice" } },
      },
    },
  },
  components: {
    schemas: {
      Invoice: {
        type: "object",
        properties: { id: { type: "string" }, total: { type: ["integer", "null"] } },
      },
    },
    securitySchemes: { bearerAuth: { type: "apiKey", in: "header", name: "X-Billing-Key" } },
  },
});

function startFixtureServer(): void {
  createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const json = (status: number, body: Buffer | string) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(request.method === "HEAD" ? undefined : body);
    };

    if (url.pathname === "/openapi.json") return json(200, spec);
    if (url.pathname === "/billing/openapi.json") return json(200, billing);
    if (url.pathname === "/private/openapi.json") {
      const authorized = request.headers.authorization === `Bearer ${FIXTURE_TOKEN}`;
      return authorized ? json(200, spec) : json(401, '{"error":"unauthorized"}');
    }
    return json(404, '{"error":"not found"}');
  }).listen(FIXTURE_PORT, "127.0.0.1");
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd: appDir, stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** The password of the built-in admin in the suite's own environment. */
export const ADMIN_PASSWORD = "e2e-password";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(statePath, { recursive: true, force: true });
  run("pnpm", [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    statePath,
  ]);

  startFixtureServer();
  const env = {
    ...process.env,
    // Ignore the developer's .env; the suite brings its own secrets.
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    OPENAPI_PROXY_E2E: JSON.stringify({
      statePath,
      vars: {
        AUTH_SECRET: "e2e-secret-used-only-by-the-test-suite",
        ADMIN_PASSWORD,
        // The landing page and the blog are part of what is tested.
        PUBLIC_SITE: "true",
        // Someone to ask for Pro, which is what makes an instance sell plans: the
        // suite's workspace is on Free, and the journeys stay within it.
        CONTACT_EMAIL: "hello@example.com",
      },
    }),
  };
  // E2E_PREVIEW=1 runs the journeys against the production build instead of the
  // dev server: the real bundles, the real Content-Security-Policy, no drafts.
  if (PREVIEW) run("pnpm", ["exec", "vite", "build"], env);
  const vite = spawn(
    "pnpm",
    ["exec", "vite", PREVIEW ? "preview" : "dev", "--port", String(APP_PORT), "--strictPort"],
    { cwd: appDir, stdio: "inherit", env },
  );
  vite.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      vite.kill(signal);
      process.exit(0);
    });
  }
}
