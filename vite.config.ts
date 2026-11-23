import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { defineConfig, loadEnv } from "vite";

// The end-to-end suite runs the app on its own port, with its own database
// and its own secrets, so it never depends on (or touches) a developer's setup.
const e2e = process.env.OPENAPI_PROXY_E2E
  ? (JSON.parse(process.env.OPENAPI_PROXY_E2E) as {
      statePath: string;
      vars: Record<string, string>;
    })
  : undefined;

// 7732 spells SPEC on a phone keypad, and nothing else is likely to sit on it.
const port = Number(process.env.PORT) || 7732;

export default defineConfig(({ mode, command }) => {
  // Where *your* deployment lives, kept out of the repository. `pnpm run deploy`
  // builds in "deploy" mode, which reads a gitignored .env.deploy (or the
  // environment) for
  //   OPENAPI_PROXY_D1_DATABASE_ID   the D1 database to bind
  //   OPENAPI_PROXY_DOMAIN           a custom domain to serve on, e.g. proxy.example.com
  // and, each becoming the Worker variable of the same name without the prefix,
  //   OPENAPI_PROXY_APP_URL          where the instance lives (defaults to the custom domain)
  //   OPENAPI_PROXY_ALLOWED_EMAILS   who may sign in
  //   OPENAPI_PROXY_EMAIL_FROM       the sender of invitations and change notices
  //   OPENAPI_PROXY_CLOUDFLARE_EMAIL_ACCOUNT_ID   the account whose Email Sending is used
  //   OPENAPI_PROXY_PUBLIC_SITE      "true" to serve the landing page and the blog
  //   OPENAPI_PROXY_CONTACT_EMAIL    where "write to us" points, and requests for Pro go; setting it turns plans on
  // Secrets (AUTH_SECRET, GOOGLE_CLIENT_SECRET, CLOUDFLARE_EMAIL_TOKEN, ...) are not
  // set here: `wrangler secret put NAME`.
  // Development, tests and plain builds never see these and use wrangler.jsonc as it is.
  const target = mode === "deploy" ? loadEnv(mode, process.cwd(), "OPENAPI_PROXY_") : {};
  const databaseId = target.OPENAPI_PROXY_D1_DATABASE_ID;
  const domain = target.OPENAPI_PROXY_DOMAIN;
  const settings: Record<string, string> = {};
  if (domain) settings.APP_URL = `https://${domain}`;
  for (const name of [
    "APP_URL",
    "ALLOWED_EMAILS",
    "EMAIL_FROM",
    "CLOUDFLARE_EMAIL_ACCOUNT_ID",
    "PUBLIC_SITE",
    "CONTACT_EMAIL",
  ]) {
    const value = target[`OPENAPI_PROXY_${name}`];
    if (value) settings[name] = value;
  }

  return {
    plugins: [
      // Compiles src/web/content into the `collections/*` modules (see source.config.ts).
      mdx(),
      tailwindcss(),
      cloudflare({
        // The Worker is Start's server environment: one bundle, one Worker.
        viteEnvironment: { name: "ssr" },
        ...(e2e ? { persistState: { path: e2e.statePath } } : {}),
        // The plugin deep-merges what is returned and appends arrays, so lists
        // (bindings, routes) are changed in place instead.
        config: (config) => {
          // The landing page and blog are off unless asked for (a self-hosted
          // instance opens on sign-in). Local development works on them.
          if (command === "serve") config.vars = { PUBLIC_SITE: "true", ...config.vars };
          if (e2e) config.vars = { ...config.vars, ...e2e.vars };
          // The suite clicks through the app faster than any person, as one
          // workspace. Limiting it would test the limiter, not the app.
          if (e2e) config.ratelimits = [];
          config.vars = { ...config.vars, ...settings };
          if (databaseId) {
            for (const database of config.d1_databases ?? []) database.database_id = databaseId;
          }
          if (domain) {
            config.routes = [{ pattern: domain, custom_domain: true }];
            // One canonical origin: sessions and the OAuth redirect belong to the domain.
            config.workers_dev = false;
            config.preview_urls = false;
          }
        },
      }),
      tanstackStart({ srcDirectory: "src/web" }),
      // Has to come after Start.
      react(),
    ],
    // The development server finds these two only when the first blog or docs
    // page is asked for, then optimizes them and reloads itself, which loses
    // whatever the browser was doing at that moment (a click, in the journeys
    // on CI, where the cache is cold every time). Named here, they are
    // optimized when the server starts.
    environments: {
      ssr: {
        optimizeDeps: {
          include: ["fumadocs-mdx/runtime/browser", "fumadocs-mdx/runtime/server"],
        },
      },
    },
    // Google sign-in needs the port in the registered redirect URI
    // (http://localhost:7732/api/auth/callback/google). Password sign-in works
    // on any port: PORT=3000 pnpm dev
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
    resolve: {
      alias: {
        "@": new URL("./src/web", import.meta.url).pathname,
        // The variant editor and what it is drawn with: also shown by `openapi-proxy dev`.
        "@editor": new URL("./packages/editor/src", import.meta.url).pathname,
        collections: new URL("./.source", import.meta.url).pathname,
      },
      // Fumadocs ships its own copies otherwise, and two Reacts do not hydrate.
      dedupe: ["react", "react-dom"],
    },
  };
});
